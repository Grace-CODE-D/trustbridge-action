/**
 * Simple in-memory cache for Horizon API responses.
 *
 * Lifetime: this cache lives only in the Node.js process heap for a single
 * invocation of the action (one workflow step run). It is created fresh
 * every time `dist/index.js` starts and is discarded when that process
 * exits. It is never persisted to disk and never shared across:
 *   - separate steps in the same job (each `uses:` step is its own process),
 *   - separate jobs in the same workflow,
 *   - matrix legs (each matrix combination runs on its own runner/process),
 *   - concurrent or subsequent workflow runs.
 *
 * Cache keys are built in `horizon.ts` (`buildCacheKey`) from the
 * normalized Horizon base URL and the Stellar address being checked, so
 * entries for different Horizon endpoints (e.g. mainnet vs testnet in a
 * matrix build) or different accounts never collide even when a cache
 * instance is reused programmatically (e.g. in tests).
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class SimpleCache {
  private store = new Map<string, CacheEntry<unknown>>();

  /**
   * Get a cached value if it exists and hasn't expired.
   */
  get<T>(key: string): T | null {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Set a value in the cache with an expiration time.
   * @param key Cache key
   * @param data Data to cache
   * @param ttlMs Time to live in milliseconds (default: 60 seconds)
   */
  set<T>(key: string, data: T, ttlMs: number = 60_000): void {
    this.store.set(key, {
      data,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Get cache statistics for debugging.
   */
  getStats(): { size: number; entries: string[] } {
    return {
      size: this.store.size,
      entries: Array.from(this.store.keys()),
    };
  }
}

export const defaultCache = new SimpleCache();
