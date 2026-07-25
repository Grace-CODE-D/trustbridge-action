/**
 * Tests for src/resilience.ts
 * Covers: backoff math, jitter, RateLimiter, retryWithBackoff,
 * CircuitBreaker, and the new runCliCheck CLI command (Issue #46).
 */

import {
  DEFAULT_RETRY_POLICY,
  CircuitBreaker,
  RateLimiter,
  addJitter,
  calculateBackoffDelay,
  retryWithBackoff,
  runCliCheck,
  sleep,
  type CliCheckOptions,
  type FetchFn,
} from '../src/resilience';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetch(responses: Array<{ status: number } | Error>): FetchFn {
  let call = 0;
  return async () => {
    const r = responses[call++];
    if (r instanceof Error) throw r;
    return r as { status: number };
  };
}

// ---------------------------------------------------------------------------
// calculateBackoffDelay
// ---------------------------------------------------------------------------

describe('calculateBackoffDelay', () => {
  it('doubles delay on each attempt', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, initialDelayMs: 100, backoffMultiplier: 2 };
    expect(calculateBackoffDelay(0, policy)).toBe(100);
    expect(calculateBackoffDelay(1, policy)).toBe(200);
    expect(calculateBackoffDelay(2, policy)).toBe(400);
  });

  it('caps at maxDelayMs', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, initialDelayMs: 1000, maxDelayMs: 2000, backoffMultiplier: 10 };
    expect(calculateBackoffDelay(3, policy)).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// addJitter
// ---------------------------------------------------------------------------

describe('addJitter', () => {
  it('returns a non-negative value', () => {
    for (let i = 0; i < 50; i++) {
      expect(addJitter(100)).toBeGreaterThanOrEqual(0);
    }
  });

  it('stays within ±jitterPercent of the input', () => {
    const base = 1000;
    const pct = 10;
    for (let i = 0; i < 50; i++) {
      const result = addJitter(base, pct);
      expect(result).toBeGreaterThanOrEqual(base * (1 - pct / 100) - 1);
      expect(result).toBeLessThanOrEqual(base * (1 + pct / 100) + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

describe('sleep', () => {
  it('resolves after approximately the given duration', async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

describe('RateLimiter', () => {
  it('allows requests up to capacity', () => {
    const rl = new RateLimiter(3, 10);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(false);
  });

  it('waitTimeMs returns 0 when tokens are available', () => {
    const rl = new RateLimiter(5, 10);
    expect(rl.waitTimeMs()).toBe(0);
  });

  it('waitTimeMs is positive when tokens are exhausted', () => {
    const rl = new RateLimiter(1, 1);
    rl.tryConsume();
    expect(rl.waitTimeMs()).toBeGreaterThan(0);
  });

  it('reset restores full capacity', () => {
    const rl = new RateLimiter(2, 10);
    rl.tryConsume();
    rl.tryConsume();
    expect(rl.tryConsume()).toBe(false);
    rl.reset();
    expect(rl.tryConsume()).toBe(true);
  });

  it('getAvailableTokens returns floor of current tokens', () => {
    const rl = new RateLimiter(5, 10);
    expect(rl.getAvailableTokens()).toBe(5);
    rl.tryConsume(3);
    expect(rl.getAvailableTokens()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// retryWithBackoff
// ---------------------------------------------------------------------------

describe('retryWithBackoff', () => {
  it('returns the result on first success', async () => {
    const result = await retryWithBackoff(async () => 'ok', {
      ...DEFAULT_RETRY_POLICY,
      initialDelayMs: 1,
    });
    expect(result).toBe('ok');
  });

  it('retries on failure and returns eventual success', async () => {
    let attempts = 0;
    const result = await retryWithBackoff(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error('transient');
        return 'success';
      },
      { ...DEFAULT_RETRY_POLICY, maxRetries: 3, initialDelayMs: 1 },
    );
    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('throws after exhausting retries', async () => {
    await expect(
      retryWithBackoff(async () => { throw new Error('permanent'); }, {
        ...DEFAULT_RETRY_POLICY,
        maxRetries: 2,
        initialDelayMs: 1,
      }),
    ).rejects.toThrow('permanent');
  });

  it('does not retry when shouldRetry returns false', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => { calls++; throw new Error('no retry'); },
        { ...DEFAULT_RETRY_POLICY, maxRetries: 5, initialDelayMs: 1 },
        () => false,
      ),
    ).rejects.toThrow('no retry');
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

describe('CircuitBreaker', () => {
  it('starts in CLOSED state', () => {
    const cb = new CircuitBreaker(3, 1000);
    expect(cb.getState()).toBe('CLOSED');
  });

  it('remains CLOSED on success', async () => {
    const cb = new CircuitBreaker(3, 1000);
    await cb.execute(async () => 'ok');
    expect(cb.getState()).toBe('CLOSED');
  });

  it('opens after reaching the failure threshold', async () => {
    const cb = new CircuitBreaker(2, 60000);
    for (let i = 0; i < 2; i++) {
      await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
    }
    expect(cb.getState()).toBe('OPEN');
  });

  it('rejects immediately when OPEN', async () => {
    const cb = new CircuitBreaker(1, 60000);
    await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
    await expect(cb.execute(async () => 'should not reach')).rejects.toThrow(/OPEN/);
  });

  it('transitions to HALF after resetTimeout elapses', async () => {
    jest.useFakeTimers();
    const cb = new CircuitBreaker(1, 500);
    await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
    expect(cb.getState()).toBe('OPEN');
    jest.advanceTimersByTime(600);
    // Next call attempt transitions to HALF
    await cb.execute(async () => 'probe').catch(() => {});
    // After a successful probe, state should be CLOSED
    expect(cb.getState()).toBe('CLOSED');
    jest.useRealTimers();
  });

  it('reset() clears state back to CLOSED', async () => {
    const cb = new CircuitBreaker(1, 60000);
    await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
    cb.reset();
    expect(cb.getState()).toBe('CLOSED');
  });
});

// ---------------------------------------------------------------------------
// runCliCheck — Issue #46
// ---------------------------------------------------------------------------

describe('runCliCheck', () => {
  const baseOptions: CliCheckOptions = {
    address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    horizonUrl: 'https://horizon.stellar.org',
    timeoutMs: 5000,
    retryPolicy: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 100, backoffMultiplier: 2, timeoutMs: 5000 },
  };

  it('returns reachable=true on HTTP 200', async () => {
    const fetch = makeFetch([{ status: 200 }]);
    const result = await runCliCheck(baseOptions, fetch);

    expect(result.reachable).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.retries).toBe(0);
    expect(result.message).toContain('reachable');
  });

  it('returns reachable=false with statusCode 404 for unfunded account', async () => {
    const fetch = makeFetch([{ status: 404 }]);
    const result = await runCliCheck(baseOptions, fetch);

    expect(result.reachable).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(result.message).toContain('not found');
    expect(result.message).toContain('not yet funded');
  });

  it('reports statusCode for non-200/404 responses', async () => {
    const fetch = makeFetch([{ status: 503 }]);
    const result = await runCliCheck(baseOptions, fetch);

    expect(result.reachable).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.message).toContain('503');
  });

  it('retries on transient 429 and succeeds on subsequent attempt', async () => {
    const fetch = makeFetch([{ status: 429 }, { status: 200 }]);
    const result = await runCliCheck(
      {
        ...baseOptions,
        retryPolicy: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 10, backoffMultiplier: 1, timeoutMs: 5000 },
      },
      fetch,
    );

    expect(result.reachable).toBe(true);
    expect(result.retries).toBeGreaterThanOrEqual(1);
  });

  it('reports network error when fetch throws', async () => {
    const fetch = makeFetch([new Error('ECONNREFUSED')]);
    const result = await runCliCheck(baseOptions, fetch);

    expect(result.reachable).toBe(false);
    expect(result.statusCode).toBeUndefined();
    expect(result.message).toContain('Could not reach Horizon');
  });

  it('uses default horizonUrl when none is provided', async () => {
    let capturedUrl = '';
    const fetch: FetchFn = async (url) => { capturedUrl = url; return { status: 200 }; };
    await runCliCheck({ address: baseOptions.address }, fetch);
    expect(capturedUrl).toContain('horizon.stellar.org');
  });

  it('durationMs is always non-negative', async () => {
    const fetch = makeFetch([{ status: 200 }]);
    const result = await runCliCheck(baseOptions, fetch);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
