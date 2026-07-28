import { HorizonAccount } from './horizon';
/** Stellar public network base reserve per ledger entry (XLM). */
export declare const STELLAR_BASE_RESERVE_XLM = 0.5;
/** Minimum balance required to activate a new account (XLM). */
export declare const STELLAR_MIN_ACCOUNT_BALANCE_XLM = 1;
export interface CheckConfig {
    assetCode: string;
    assetIssuer: string;
    minXlmReserve: number;
    horizonUrl?: string;
}
export interface CheckResultItem {
    passed: boolean;
    label: string;
    detail: string;
}
export interface ValidationResult {
    valid: boolean;
    accountFunded: boolean;
    trustlineExists: boolean;
    xlmBalance: string;
    xlmReserveMet: boolean;
    checks: CheckResultItem[];
    remediation?: string;
}
export declare function normalizeStellarAddress(address: string): string;
export declare function isValidStellarAddress(address: string): boolean;
export declare function validateStellarAddress(address: string): void;
export declare function parseMinXlmReserve(value: string): number;
export declare function estimateTrustlineSetupCost(): number;
export declare function formatXlmDeficit(required: number, actual: number): string;
export declare function runAccountChecks(account: HorizonAccount, config: CheckConfig): ValidationResult;
export declare function unfundedAccountResult(stellarAddress: string, config: CheckConfig): ValidationResult;
export declare function getFailedCheckLabels(result: ValidationResult): string[];
export declare function horizonFailureResult(message: string, config: CheckConfig): ValidationResult;
export interface ReserveRequirement {
    required: number;
    actual: number;
    missing: string;
    met: boolean;
}
export declare function buildReserveRequirement(required: number, actual: number): ReserveRequirement;
/** Per-asset trustline check result for multi-asset validation. */
export interface AssetTrustlineResult {
    assetCode: string;
    assetIssuer: string;
    trustlineExists: boolean;
}
/**
 * Run trustline checks for multiple assets against an already-fetched account.
 * Returns per-asset results and an aggregate `allTrustlinesExist` flag.
 */
export declare function runMultiAssetChecks(account: HorizonAccount, assets: Array<{
    assetCode: string;
    assetIssuer: string;
}>): {
    results: AssetTrustlineResult[];
    allTrustlinesExist: boolean;
};
export interface ValidationGate {
    ready: boolean;
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
    failedLabels: string[];
}
/**
 * Build a machine-readable gate summary from the validation result.
 * This stays intentionally small so it can be consumed by comment output,
 * dashboards, or future release automation without re-parsing Markdown.
 */
export declare function buildValidationGate(result: ValidationResult): ValidationGate;
