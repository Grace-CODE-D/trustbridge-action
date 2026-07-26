import {
  CONTRACT_ADDRESS_TAG_KEY,
  MetricsCollector,
  OctokitMetrics,
  classifyOctokitStatus,
  OctokitOutcome,
  OctokitOperationRecord,
} from '../src/metrics';

const VALID_CONTRACT_ADDRESS = 'C' + 'A'.repeat(55);

// ---------------------------------------------------------------------------
// Existing MetricsCollector tests (unchanged)
// ---------------------------------------------------------------------------

describe('MetricsCollector.recordMetric', () => {
  it('records a metric without a contract address tag', () => {
    const metrics = new MetricsCollector();
    metrics.recordMetric('latency', 42, 'ms');

    const summary = metrics.getSummary();
    expect(summary.totalMetrics).toBe(1);
    expect(summary.metrics[0]).toMatchObject({ name: 'latency', value: 42, unit: 'ms' });
  });

  it('records a metric with a valid contractAddress tag', () => {
    const metrics = new MetricsCollector();
    metrics.recordMetric('trustline_check', 1, 'count', {
      [CONTRACT_ADDRESS_TAG_KEY]: VALID_CONTRACT_ADDRESS,
    });

    const summary = metrics.getSummary();
    expect(summary.metrics[0].tags?.[CONTRACT_ADDRESS_TAG_KEY]).toBe(VALID_CONTRACT_ADDRESS);
  });

  it('throws when the contractAddress tag fails the C-address policy', () => {
    const metrics = new MetricsCollector();

    expect(() =>
      metrics.recordMetric('trustline_check', 1, 'count', {
        [CONTRACT_ADDRESS_TAG_KEY]: 'not-a-contract-address',
      }),
    ).toThrow(/Invalid contractAddress tag/);

    expect(metrics.getSummary().totalMetrics).toBe(0);
  });
});

describe('MetricsCollector.recordContractMetric', () => {
  it('tags the metric with the given contract address', () => {
    const metrics = new MetricsCollector();
    metrics.recordContractMetric('asset_issuer_contract_validated', 1, VALID_CONTRACT_ADDRESS);

    const summary = metrics.getSummary();
    expect(summary.metrics[0]).toMatchObject({
      name: 'asset_issuer_contract_validated',
      value: 1,
      tags: { [CONTRACT_ADDRESS_TAG_KEY]: VALID_CONTRACT_ADDRESS },
    });
  });

  it('rejects an invalid contract address without recording a metric', () => {
    const metrics = new MetricsCollector();

    expect(() =>
      metrics.recordContractMetric('asset_issuer_contract_validated', 1, 'GNOTACONTRACT'),
    ).toThrow(/Invalid contractAddress tag/);
    expect(metrics.getSummary().totalMetrics).toBe(0);
  });
});

describe('MetricsCollector counters, timers, and export', () => {
  it('increments and reads counters', () => {
    const metrics = new MetricsCollector();
    metrics.incrementCounter('retries');
    metrics.incrementCounter('retries', 2);
    expect(metrics.getCounter('retries')).toBe(3);
  });

  it('times an operation and records its duration', () => {
    const metrics = new MetricsCollector();
    metrics.startTimer('horizon_fetch');
    const elapsed = metrics.stopTimer('horizon_fetch');

    expect(elapsed).not.toBeNull();
    expect(metrics.getAverageMetric('horizon_fetch_duration')).toBe(elapsed);
  });

  it('returns null when stopping a timer that was never started', () => {
    const metrics = new MetricsCollector();
    expect(metrics.stopTimer('missing')).toBeNull();
  });

  it('exports a JSON summary and resets cleanly', () => {
    const metrics = new MetricsCollector();
    metrics.recordMetric('latency', 10);
    metrics.incrementCounter('runs');

    const json = JSON.parse(metrics.toJSON());
    expect(json.totalMetrics).toBe(1);
    expect(json.counters.runs).toBe(1);

    metrics.reset();
    expect(metrics.getSummary().totalMetrics).toBe(0);
    expect(metrics.getCounter('runs')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// classifyOctokitStatus — Wave #37
// ---------------------------------------------------------------------------

describe('classifyOctokitStatus', () => {
  it.each<[number, OctokitOutcome]>([
    [200, 'success'],
    [201, 'success'],
    [204, 'success'],
    [401, 'auth_error'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [502, 'server_error'],
    [503, 'server_error'],
    [0,   'network_error'],
    [400, 'unknown'],
    [422, 'unknown'],
  ])('status %i → %s', (status, expected) => {
    expect(classifyOctokitStatus(status)).toBe(expected);
  });

  it('classifies 403 with x-ratelimit-remaining=0 as rate_limited', () => {
    expect(classifyOctokitStatus(403, { 'x-ratelimit-remaining': '0' })).toBe('rate_limited');
  });

  it('classifies 403 without rate-limit header as auth_error', () => {
    expect(classifyOctokitStatus(403, {})).toBe('auth_error');
    expect(classifyOctokitStatus(403)).toBe('auth_error');
  });
});

// ---------------------------------------------------------------------------
// OctokitMetrics — Wave #37
// ---------------------------------------------------------------------------

describe('OctokitMetrics', () => {
  describe('track: success path', () => {
    it('records a successful operation with status 200', async () => {
      const om = new OctokitMetrics();
      const response = { status: 200, headers: {}, data: { html_url: 'https://github.com/x' } };
      const result = await om.track('issues.createComment', async () => response);

      expect(result).toBe(response);
      expect(om.size).toBe(1);
      const summary = om.getSummary();
      expect(summary.totalCalls).toBe(1);
      expect(summary.successCount).toBe(1);
      expect(summary.failureCount).toBe(0);
      expect(summary.outcomeBreakdown.success).toBe(1);
      expect(summary.operations[0].operation).toBe('issues.createComment');
      expect(summary.operations[0].statusCode).toBe(200);
      expect(summary.operations[0].outcome).toBe('success');
      expect(summary.operations[0].latencyMs).toBeGreaterThanOrEqual(0);
      expect(summary.operations[0].retries).toBe(0);
      expect(summary.operations[0].startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('records a 201 created response as success', async () => {
      const om = new OctokitMetrics();
      await om.track('issues.createComment', async () => ({ status: 201, headers: {} }));
      expect(om.getSummary().operations[0].outcome).toBe('success');
    });

    it('accumulates latency across multiple calls', async () => {
      const om = new OctokitMetrics();
      await om.track('op1', async () => ({ status: 200, headers: {} }));
      await om.track('op2', async () => ({ status: 200, headers: {} }));
      expect(om.getSummary().totalCalls).toBe(2);
      expect(om.getSummary().totalLatencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('track: failure paths', () => {
    it('records a 401 as auth_error and rethrows', async () => {
      const om = new OctokitMetrics();
      const err = Object.assign(new Error('Bad credentials'), { status: 401 });
      await expect(om.track('issues.createComment', async () => { throw err; }))
        .rejects.toThrow('Bad credentials');
      const summary = om.getSummary();
      expect(summary.operations[0].outcome).toBe('auth_error');
      expect(summary.operations[0].statusCode).toBe(401);
      expect(summary.operations[0].errorMessage).toBe('Bad credentials');
      expect(summary.failureCount).toBe(1);
    });

    it('records a 403 with rate-limit header as rate_limited', async () => {
      const om = new OctokitMetrics();
      const err = Object.assign(new Error('Forbidden'), {
        status: 403,
        response: { headers: { 'x-ratelimit-remaining': '0' } },
      });
      await expect(om.track('issues.addLabels', async () => { throw err; })).rejects.toThrow();
      expect(om.getSummary().operations[0].outcome).toBe('rate_limited');
    });

    it('records a 404 as not_found', async () => {
      const om = new OctokitMetrics();
      const err = Object.assign(new Error('Not Found'), { status: 404 });
      await expect(om.track('issues.removeLabel', async () => { throw err; })).rejects.toThrow();
      expect(om.getSummary().operations[0].outcome).toBe('not_found');
    });

    it('records a 500 as server_error', async () => {
      const om = new OctokitMetrics();
      const err = Object.assign(new Error('Internal Server Error'), { status: 500 });
      await expect(om.track('issues.updateComment', async () => { throw err; })).rejects.toThrow();
      expect(om.getSummary().operations[0].outcome).toBe('server_error');
    });

    it('records a network error (no status) as network_error', async () => {
      const om = new OctokitMetrics();
      await expect(om.track('issues.createComment', async () => { throw new Error('ECONNREFUSED'); }))
        .rejects.toThrow();
      const op = om.getSummary().operations[0];
      expect(op.outcome).toBe('network_error');
      expect(op.statusCode).toBe(0);
    });
  });

  describe('track: retry count propagation', () => {
    it('records the caller-supplied retry count', async () => {
      const om = new OctokitMetrics();
      await om.track('issues.createComment', async () => ({ status: 200, headers: {} }), 2);
      expect(om.getSummary().operations[0].retries).toBe(2);
      expect(om.getSummary().totalRetries).toBe(2);
    });
  });

  describe('record: direct insert', () => {
    it('accepts pre-resolved records', () => {
      const om = new OctokitMetrics();
      const rec: OctokitOperationRecord = {
        operation: 'issues.createComment',
        statusCode: 200,
        latencyMs: 42,
        outcome: 'success',
        retries: 0,
        startedAt: new Date().toISOString(),
      };
      om.record(rec);
      expect(om.size).toBe(1);
      expect(om.getSummary().operations[0]).toEqual(rec);
    });
  });

  describe('getSummary: aggregates', () => {
    it('computes averageLatencyMs correctly', async () => {
      const om = new OctokitMetrics();
      om.record({ operation: 'a', statusCode: 200, latencyMs: 100, outcome: 'success', retries: 0, startedAt: '' });
      om.record({ operation: 'b', statusCode: 200, latencyMs: 200, outcome: 'success', retries: 0, startedAt: '' });
      expect(om.getSummary().averageLatencyMs).toBe(150);
    });

    it('returns 0 averageLatencyMs when no records', () => {
      expect(new OctokitMetrics().getSummary().averageLatencyMs).toBe(0);
    });

    it('outcomeBreakdown includes all outcome categories', () => {
      const summary = new OctokitMetrics().getSummary();
      const expected: OctokitOutcome[] = ['success', 'auth_error', 'not_found', 'rate_limited', 'server_error', 'network_error', 'unknown'];
      for (const outcome of expected) {
        expect(summary.outcomeBreakdown).toHaveProperty(outcome);
      }
    });

    it('returns a deep copy of operations so mutations do not affect the store', () => {
      const om = new OctokitMetrics();
      om.record({ operation: 'x', statusCode: 200, latencyMs: 1, outcome: 'success', retries: 0, startedAt: '' });
      const s1 = om.getSummary();
      s1.operations[0].operation = 'mutated';
      const s2 = om.getSummary();
      expect(s2.operations[0].operation).toBe('x');
    });
  });

  describe('toJSON', () => {
    it('produces valid JSON matching getSummary shape', async () => {
      const om = new OctokitMetrics();
      await om.track('issues.createComment', async () => ({ status: 200, headers: {} }));
      const json = JSON.parse(om.toJSON());
      expect(json.totalCalls).toBe(1);
      expect(json.successCount).toBe(1);
      expect(Array.isArray(json.operations)).toBe(true);
      expect(json.operations[0].operation).toBe('issues.createComment');
    });

    it('includes all outcome breakdown keys', () => {
      const json = JSON.parse(new OctokitMetrics().toJSON());
      expect(json.outcomeBreakdown).toHaveProperty('success');
      expect(json.outcomeBreakdown).toHaveProperty('auth_error');
      expect(json.outcomeBreakdown).toHaveProperty('rate_limited');
    });
  });

  describe('reset', () => {
    it('clears all records', async () => {
      const om = new OctokitMetrics();
      await om.track('x', async () => ({ status: 200, headers: {} }));
      expect(om.size).toBe(1);
      om.reset();
      expect(om.size).toBe(0);
      expect(om.getSummary().totalCalls).toBe(0);
    });
  });
});
