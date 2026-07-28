import { SimpleCache } from './cache';
export interface HorizonBalanceNative {
    balance: string;
    asset_type: 'native';
    buying_liabilities: string;
    selling_liabilities: string;
}
export interface HorizonBalanceCredit {
    balance: string;
    asset_type: 'credit_alphanum4' | 'credit_alphanum12';
    asset_code: string;
    asset_issuer: string;
    buying_liabilities: string;
    selling_liabilities: string;
    limit?: string;
}
export interface HorizonBalanceLiquidityPoolShares {
    balance: string;
    asset_type: 'liquidity_pool_shares';
    liquidity_pool_id: string;
    buying_liabilities: string;
    selling_liabilities: string;
    limit: string;
    is_authorized: boolean;
    is_authorized_to_maintain_liabilities: boolean;
}
export interface HorizonBalanceClaimable {
    asset_type: 'claimable_balance_id';
    balance: string;
    claimable_balance_id: string;
}
export type HorizonBalance = HorizonBalanceNative | HorizonBalanceCredit | HorizonBalanceLiquidityPoolShares | HorizonBalanceClaimable;
export interface HorizonAccount {
    id: string;
    account_id: string;
    sequence: string;
    subentry_count: number;
    balances: HorizonBalance[];
    /** Sponsorship fields (CAP-0033). Omitted by older Horizon snapshots — treat as 0 when absent. */
    num_sponsoring?: number;
    num_sponsored?: number;
}
export interface HorizonErrorResponse {
    type?: string;
    title?: string;
    status?: number;
    detail?: string;
}
export declare class HorizonError extends Error {
    readonly statusCode: number;
    readonly retryable: boolean;
    constructor(message: string, statusCode: number, retryable?: boolean);
}
type FetchLike = (url: string | import('node-fetch').Request, init?: import('node-fetch').RequestInit) => Promise<import('node-fetch').Response>;
export interface FetchAccountOptions {
    timeoutMs?: number;
    maxRetries?: number;
    horizonUrlFallback?: string;
    fallbackUrls?: string[];
    useCache?: boolean;
    cacheTtlMs?: number;
    cache?: SimpleCache;
    fetchFn?: FetchLike;
    /**
     * By default, a fallback URL that resolves to a *different* Stellar
     * network than the primary `horizon_url` (public vs testnet, inferred
     * from the URL) is never used — a G-address is valid on every network,
     * so a cross-network fallback can silently return funded/trustline/
     * reserve data for the wrong ledger instead of failing loudly. Set this
     * to `true` to opt into cross-network fallback anyway (e.g. deliberate
     * multi-network setups).
     */
    allowCrossNetworkFallback?: boolean;
}
export declare function normalizeHorizonUrl(baseUrl: string): string;
export declare function isRetryableStatus(status: number): boolean;
export declare function parseRetryAfterMs(response: import('node-fetch').Response): number | null;
export declare function fetchAccount(horizonUrl: string, stellarAddress: string, options?: FetchAccountOptions): Promise<HorizonAccount>;
export interface WaitForFundedAccountOptions {
    /** Total time budget to keep polling before giving up, in milliseconds. */
    timeoutMs?: number;
    /** Delay between polling attempts, in milliseconds. */
    pollIntervalMs?: number;
    /** Per-request timeout passed through to each `fetchAccount` call. */
    requestTimeoutMs?: number;
    /** Per-request retry count passed through to each `fetchAccount` call. */
    maxRetries?: number;
    /** Called after each unfunded (404) poll, before sleeping for the next attempt. */
    onPoll?: (attempt: number, elapsedMs: number) => void;
    /** Optional AbortSignal from a parent controller (e.g. job cancellation).
     *  When the signal fires, polling stops immediately without emitting a
     *  misleading "account not funded" result. */
    signal?: AbortSignal;
}
/**
 * Poll Horizon for an account until it becomes funded or the timeout budget
 * is exhausted. Only Horizon 404 ("not found") responses are treated as
 * "not yet funded" and trigger another poll — any other error (rate limit
 * exhaustion, Horizon outage, network failure) is rethrown immediately so
 * outages don't turn into a silent multi-minute hang.
 */
export declare function waitForFundedAccount(horizonUrl: string, stellarAddress: string, options?: WaitForFundedAccountOptions, fetchAccountFn?: typeof fetchAccount): Promise<HorizonAccount>;
export declare function isCreditBalance(balance: HorizonBalance): balance is HorizonBalanceCredit;
export declare function getNativeBalance(account: HorizonAccount): string;
export declare function hasTrustline(account: HorizonAccount, assetCode: string, assetIssuer: string): boolean;
/**
 * Get the trustline limit for a specific asset, if it exists.
 * Returns the limit as a string (as provided by Horizon) or '0' if not found.
 */
export declare function getTrustlineLimit(account: HorizonAccount, assetCode: string, assetIssuer: string): string;
export declare function parseHorizonBalance(balance: string): number;
export interface HorizonFetchOptions {
    maxRetries?: number;
    retryBaseDelayMs?: number;
}
export {};
