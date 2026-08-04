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
export declare class SimpleCache {
    private store;
    /**
     * Get a cached value if it exists and hasn't expired.
     */
    get<T>(key: string): T | null;
    /**
     * Set a value in the cache with an expiration time.
     * @param key Cache key
     * @param data Data to cache
     * @param ttlMs Time to live in milliseconds (default: 60 seconds)
     */
    set<T>(key: string, data: T, ttlMs?: number): void;
    /**
     * Clear all cached entries.
     */
    clear(): void;
    /**
     * Get cache statistics for debugging.
     */
    getStats(): {
        size: number;
        entries: string[];
    };
}
export declare const defaultCache: SimpleCache;
