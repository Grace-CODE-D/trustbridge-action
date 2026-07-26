import { HorizonAccount } from './horizon';
/** Stellar public network base reserve per ledger entry (XLM). */
export declare const STELLAR_BASE_RESERVE_XLM = 0.5;
/** Minimum balance required to activate a new account (XLM). */
export declare const STELLAR_MIN_ACCOUNT_BALANCE_XLM = 1;
export interface CheckConfig {
    assetCode: string;
    assetIssuer: string;
    minXlmReserve: string | number;
    minAssetBalance?: string | number;
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
    assetBalance: string;
    assetBalanceMet: boolean;
    checks: CheckResultItem[];
    remediation?: string;
}
export declare function normalizeStellarAddress(address: string): string;
export declare function isValidStellarAddress(address: string): boolean;
export declare function validateStellarAddress(address: string): void;
export declare function parseMinXlmReserve(value: string): string;
export declare function parseMinAssetBalance(value: string): string | undefined;
export declare function estimateTrustlineSetupCost(): number;
export declare function formatXlmDeficit(required: bigint, actual: bigint): string;
export declare function formatAssetDeficit(required: bigint, actual: bigint): string;
export declare function runAccountChecks(account: HorizonAccount, config: CheckConfig): ValidationResult;
export declare function unfundedAccountResult(stellarAddress: string, config: CheckConfig): ValidationResult;
export declare function getFailedCheckLabels(result: ValidationResult): string[];
export declare function horizonFailureResult(message: string, config: CheckConfig): ValidationResult;
export interface ReserveRequirement {
    required: bigint;
    actual: bigint;
    missing: string;
    met: boolean;
}
export declare function buildReserveRequirement(required: bigint, actual: bigint): ReserveRequirement;
export interface AssetBalanceRequirement {
    required: bigint;
    actual: bigint;
    missing: string;
    met: boolean;
}
export declare function buildAssetBalanceRequirement(required: bigint, actual: bigint): AssetBalanceRequirement;
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
