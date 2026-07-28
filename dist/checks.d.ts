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
/**
 * Reusable workflow: verify trustline existence for a specific asset.
 * Returns true if the account has an active trustline for the given asset code
 * and issuer, false otherwise.
 *
 * Usage in workflows:
 * ```yaml
 * - name: Verify USDC trustline
 *   run: |
 *     if check-trustline USDC ${ISSUER}; then
 *       echo "Trustline configured"
 *     fi
 * ```
 */
export declare function checkTrustlineExists(account: HorizonAccount, assetCode: string, assetIssuer: string): boolean;
/**
 * Reusable workflow: verify XLM reserve meets minimum threshold.
 * Returns true if native balance >= minReserve, false otherwise.
 *
 * Usage in workflows:
 * ```yaml
 * - name: Verify XLM reserve
 *   run: |
 *     if check-reserve ${ADDRESS} 1.5; then
 *       echo "Reserve met"
 *     fi
 * ```
 */
export declare function checkReserveMet(account: HorizonAccount, minReserve: number): boolean;
/**
 * Reusable workflow: validate StrKey format for Stellar addresses.
 * Supports both G-addresses (accounts) and C-addresses (contracts).
 * Returns true if the address matches StrKey shape, false otherwise.
 *
 * Usage in workflows:
 * ```yaml
 * - name: Validate address format
 *   run: |
 *     if validate-strkey ${ADDRESS}; then
 *       echo "Valid StrKey"
 *     fi
 * ```
 */
export declare function validateStrKeyFormat(address: string): boolean;
/**
 * Multi-asset trustline check configuration.
 */
export interface MultiAssetConfig {
    assetCode: string;
    assetIssuer: string;
    required: boolean;
}
/**
 * Reusable workflow: verify multiple asset trustlines in a single check.
 * Returns an array of results — one per asset — with pass/fail status.
 *
 * Usage in workflows:
 * ```yaml
 * - name: Verify multi-asset trustlines
 *   run: |
 *     check-multi-asset USDC,EURC ${USDC_ISSUER},${EURC_ISSUER}
 * ```
 */
export declare function checkMultiAssetTrustlines(account: HorizonAccount, assets: MultiAssetConfig[]): Array<{
    asset: string;
    issuer: string;
    exists: boolean;
    required: boolean;
}>;
/**
 * Reusable workflow: calculate recommended XLM reserve for an account.
 * Formula: base account reserve (1 XLM) + (trustline count × 0.5 XLM per entry).
 *
 * Usage in workflows:
 * ```yaml
 * - name: Calculate reserve requirement
 *   run: |
 *     RESERVE=$(calculate-reserve ${TRUSTLINE_COUNT})
 *     echo "Recommended reserve: ${RESERVE} XLM"
 * ```
 */
export declare function calculateRecommendedReserve(trustlineCount: number): number;
/**
 * Reusable workflow: check if account sponsor is configured.
 * Returns true if the account has a sponsor (num_sponsored > 0), false otherwise.
 *
 * Useful for DAO/treasury workflows where accounts may be sponsored to reduce
 * reserve requirements for contributors.
 *
 * Usage in workflows:
 * ```yaml
 * - name: Verify sponsorship
 *   run: |
 *     if check-sponsored ${ADDRESS}; then
 *       echo "Account is sponsored"
 *     fi
 * ```
 */
export declare function checkAccountSponsored(account: HorizonAccount): boolean;
/**
 * Reusable workflow example: comprehensive validation report combining all checks.
 * Produces a structured report for use in workflow decision steps or dashboard output.
 *
 * Usage in workflows:
 * ```yaml
 * - name: Generate validation report
 *   run: |
 *     REPORT=$(generate-validation-report ${ADDRESS})
 *     echo "$REPORT" > report.json
 * ```
 */
export interface ValidationReport {
    address: string;
    strKeyValid: boolean;
    accountFunded: boolean;
    xlmBalance: string;
    reserveStatus: {
        current: number;
        required: number;
        met: boolean;
        deficit: string;
    };
    trustlines: Array<{
        asset: string;
        issuer: string;
        exists: boolean;
    }>;
    sponsored: boolean;
    timestamp: string;
}
export declare function generateValidationReport(account: HorizonAccount, config: CheckConfig, additionalAssets?: MultiAssetConfig[]): ValidationReport;
