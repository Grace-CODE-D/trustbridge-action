import {
  SNOOZE_MARKER_PATTERN,
  parseSnoozeMarker,
  formatSnoozeMarker,
  evaluateSnoozeState,
  SnoozeMarker,
  SnoozeState,
} from '../src/snooze';

describe('SNOOZE_MARKER_PATTERN', () => {
  it('matches valid snooze markers with pass status', () => {
    const marker = '<!-- trustbridge-action:snooze:status=pass,timestamp=1234567890 -->';
    const match = marker.match(SNOOZE_MARKER_PATTERN);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('pass');
    expect(match?.[2]).toBe('1234567890');
  });

  it('matches valid snooze markers with fail status', () => {
    const marker = '<!-- trustbridge-action:snooze:status=fail,timestamp=9876543210 -->';
    const match = marker.match(SNOOZE_MARKER_PATTERN);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('fail');
    expect(match?.[2]).toBe('9876543210');
  });

  it('does not match malformed markers', () => {
    expect('<!-- trustbridge-action:snooze:invalid -->'.match(SNOOZE_MARKER_PATTERN)).toBeNull();
    expect('<!-- wrong:snooze:status=pass,timestamp=123 -->'.match(SNOOZE_MARKER_PATTERN)).toBeNull();
  });
});

describe('parseSnoozeMarker', () => {
  it('parses valid marker from comment body', () => {
    const body = `Some text\n<!-- trustbridge-action:snooze:status=pass,timestamp=1000 -->\nMore text`;
    const marker = parseSnoozeMarker(body);
    expect(marker).toEqual({ status: 'pass', timestamp: 1000 });
  });

  it('returns undefined for missing marker', () => {
    expect(parseSnoozeMarker('<!-- other marker -->')).toBeUndefined();
    expect(parseSnoozeMarker('')).toBeUndefined();
    expect(parseSnoozeMarker(undefined)).toBeUndefined();
  });

  it('parses fail status marker', () => {
    const body = `## Comment\n<!-- trustbridge-action:snooze:status=fail,timestamp=5000 -->`;
    const marker = parseSnoozeMarker(body);
    expect(marker).toEqual({ status: 'fail', timestamp: 5000 });
  });
});

describe('formatSnoozeMarker', () => {
  it('formats pass status marker with default timestamp', () => {
    const before = Date.now();
    const marker = formatSnoozeMarker('pass');
    const after = Date.now();

    expect(marker).toMatch(/<!-- trustbridge-action:snooze:status=pass,timestamp=\d+ -->/);
    
    // Extract timestamp and verify it's in range
    const match = marker.match(/timestamp=(\d+)/);
    const timestamp = Number(match?.[1]);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('formats fail status marker with custom timestamp', () => {
    const marker = formatSnoozeMarker('fail', 1234567890);
    expect(marker).toBe('<!-- trustbridge-action:snooze:status=fail,timestamp=1234567890 -->');
  });

  it('formats pass status marker with custom timestamp', () => {
    const marker = formatSnoozeMarker('pass', 9999999999);
    expect(marker).toBe('<!-- trustbridge-action:snooze:status=pass,timestamp=9999999999 -->');
  });
});

describe('evaluateSnoozeState', () => {
  describe('when current check passes', () => {
    it('always posts (unsnoozes) regardless of prior state', () => {
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: Date.now() - 1000 };
      const state = evaluateSnoozeState(true, priorMarker, 60000);
      
      expect(state.isSnoozed).toBe(false);
      expect(state.lastStatus).toBe('fail');
      expect(state.lastTimestamp).toBe(priorMarker.timestamp);
    });

    it('posts with no prior marker', () => {
      const state = evaluateSnoozeState(true, undefined, 60000);
      expect(state.isSnoozed).toBe(false);
      expect(state.lastStatus).toBeUndefined();
      expect(state.lastTimestamp).toBeUndefined();
    });
  });

  describe('when current check fails with no prior marker', () => {
    it('posts (first failure)', () => {
      const state = evaluateSnoozeState(false, undefined, 60000);
      expect(state.isSnoozed).toBe(false);
      expect(state.lastStatus).toBeUndefined();
    });
  });

  describe('when current check fails and prior status was pass', () => {
    it('posts (status changed)', () => {
      const priorMarker: SnoozeMarker = { status: 'pass', timestamp: Date.now() - 10000 };
      const state = evaluateSnoozeState(false, priorMarker, 60000);
      
      expect(state.isSnoozed).toBe(false);
      expect(state.lastStatus).toBe('pass');
      expect(state.elapsedMs).toBeGreaterThan(0);
    });
  });

  describe('when current check fails and prior status was fail', () => {
    it('snoozes when within window', () => {
      const now = Date.now();
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: now - 5000 }; // 5s ago
      const snoozeWindowMs = 60000; // 1 minute
      
      const state = evaluateSnoozeState(false, priorMarker, snoozeWindowMs);
      
      expect(state.isSnoozed).toBe(true);
      expect(state.lastStatus).toBe('fail');
      expect(state.lastTimestamp).toBe(priorMarker.timestamp);
      expect(state.elapsedMs).toBeLessThan(snoozeWindowMs);
      expect(state.elapsedMs).toBeGreaterThan(0);
    });

    it('posts when outside window', () => {
      const now = Date.now();
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: now - 70000 }; // 70s ago
      const snoozeWindowMs = 60000; // 1 minute
      
      const state = evaluateSnoozeState(false, priorMarker, snoozeWindowMs);
      
      expect(state.isSnoozed).toBe(false);
      expect(state.lastStatus).toBe('fail');
      expect(state.elapsedMs).toBeGreaterThan(snoozeWindowMs);
    });

    it('exactly at window boundary posts', () => {
      const now = Date.now();
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: now - 60000 }; // exactly 1 min ago
      const snoozeWindowMs = 60000;
      
      const state = evaluateSnoozeState(false, priorMarker, snoozeWindowMs);
      
      // At the boundary, we're not withinWindow (elapsed >= window)
      expect(state.isSnoozed).toBe(false);
    });
  });

  describe('zero snooze window', () => {
    it('never snoozes even with repeated failures', () => {
      const now = Date.now();
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: now - 5000 };
      
      const state = evaluateSnoozeState(false, priorMarker, 0);
      
      // window is 0, so elapsed >= window is always true
      expect(state.isSnoozed).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles very large elapsed times', () => {
      const priorMarker: SnoozeMarker = { status: 'fail', timestamp: 1000 };
      const state = evaluateSnoozeState(false, priorMarker, 60000);
      
      expect(state.isSnoozed).toBe(false);
      expect(state.elapsedMs).toBeGreaterThan(60000);
    });

    it('handles negative elapsed (clock skew)', () => {
      // Even if clock skewed backwards, if elapsed < window we snooze
      const now = Date.now();
      const futureMarker: SnoozeMarker = { status: 'fail', timestamp: now + 5000 };
      
      const state = evaluateSnoozeState(false, futureMarker, 60000);
      
      // Even though elapsed is technically negative, we treat it as < window
      // The condition is: elapsedMs < snoozeWindowMs
      // If timestamp is future, elapsedMs is negative, so yes < 60000
      expect(state.isSnoozed).toBe(true);
    });
  });
});
