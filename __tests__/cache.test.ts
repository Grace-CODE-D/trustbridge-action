import { SimpleCache } from '../src/cache';

describe('SimpleCache', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns null on a miss', () => {
    const cache = new SimpleCache();
    expect(cache.get('missing-key')).toBeNull();
  });

  it('returns the stored value on a hit', () => {
    const cache = new SimpleCache();
    cache.set('key', { foo: 'bar' });
    expect(cache.get('key')).toEqual({ foo: 'bar' });
  });

  it('serves a value that has not yet expired', () => {
    const cache = new SimpleCache();
    cache.set('key', 'value', 1000);
    jest.advanceTimersByTime(999);
    expect(cache.get('key')).toBe('value');
  });

  it('expires a value once its TTL has elapsed and evicts it from the store', () => {
    const cache = new SimpleCache();
    cache.set('key', 'value', 1000);
    jest.advanceTimersByTime(1001);

    expect(cache.get('key')).toBeNull();
    expect(cache.getStats().entries).not.toContain('key');
  });

  it('refetches (does not resurrect) an expired entry after a fresh set', () => {
    const cache = new SimpleCache();
    cache.set('key', 'stale', 1000);
    jest.advanceTimersByTime(1001);
    expect(cache.get('key')).toBeNull();

    cache.set('key', 'fresh', 1000);
    expect(cache.get('key')).toBe('fresh');
  });

  it('defaults to a 60 second TTL when none is provided', () => {
    const cache = new SimpleCache();
    cache.set('key', 'value');
    jest.advanceTimersByTime(59_999);
    expect(cache.get('key')).toBe('value');
    jest.advanceTimersByTime(2);
    expect(cache.get('key')).toBeNull();
  });

  it('clear() removes all entries regardless of TTL', () => {
    const cache = new SimpleCache();
    cache.set('a', 1, 60_000);
    cache.set('b', 2, 60_000);
    cache.clear();
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBeNull();
    expect(cache.getStats()).toEqual({ size: 0, entries: [] });
  });

  it('getStats() reports size and keys', () => {
    const cache = new SimpleCache();
    cache.set('a', 1, 60_000);
    cache.set('b', 2, 60_000);
    const stats = cache.getStats();
    expect(stats.size).toBe(2);
    expect(stats.entries.sort()).toEqual(['a', 'b']);
  });

  it('keeps independent TTLs per key', () => {
    const cache = new SimpleCache();
    cache.set('short', 'expires-soon', 100);
    cache.set('long', 'expires-later', 10_000);

    jest.advanceTimersByTime(101);

    expect(cache.get('short')).toBeNull();
    expect(cache.get('long')).toBe('expires-later');
  });
});
