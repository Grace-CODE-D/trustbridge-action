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
}
export type HorizonBalance = HorizonBalanceNative | HorizonBalanceCredit;
export interface HorizonAccount {
    id: string;
    account_id: string;
    sequence: string;
    subentry_count: number;
    balances: HorizonBalance[];
    num_sponsoring: number;
    num_sponsored: number;
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
export type FetchLike = (url: string | import('node-fetch').Request, init?: import('node-fetch').RequestInit) => Promise<import('node-fetch').Response>;
export interface FetchAccountOptions {
    timeoutMs?: number;
    maxRetries?: number;
    horizonUrlFallback?: string;
    fallbackUrls?: string[];
    useCache?: boolean;
    cacheTtlMs?: number;
    cache?: SimpleCache;
    fetchFn?: FetchLike;
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
export declare function getAssetBalance(account: HorizonAccount, assetCode: string, assetIssuer: string): string;
export declare function parseStroops(value: string | number | undefined): bigint;
export declare function formatStroops(stroops: bigint): string;
export declare function parseHorizonBalance(balance: string): bigint;
/**
 * Fetches the network_passphrase from the Horizon root endpoint.
 */
export declare function fetchNetworkPassphrase(horizonUrl: string, options?: FetchAccountOptions): Promise<string>;
export interface HorizonFetchOptions {
    maxRetries?: number;
    retryBaseDelayMs?: number;
}
