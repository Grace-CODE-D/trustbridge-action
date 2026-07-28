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
export interface AddressExtractionResult {
    /** The first valid Stellar G-address found, or undefined if none. */
    address: string | undefined;
    /** All valid G-addresses found in the text (deduplicated, order preserved). */
    allAddresses: string[];
}
/**
 * Extract Stellar G-addresses from free-form text such as an issue body.
 *
 * Scans the text for all 56-character sequences starting with G followed by
 * base32 characters, validates each one, and returns the first valid hit
 * together with a deduplicated list of every valid address found.
 *
 * Safe to call with arbitrary untrusted input — performs no network requests
 * and never throws.
 *
 * @param text - Issue body, comment text, or any free-form string.
 * @returns `address` (first found) and `allAddresses` (all found, deduped).
 */
export declare function extractStellarAddressFromText(text: string | undefined | null): AddressExtractionResult;
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
