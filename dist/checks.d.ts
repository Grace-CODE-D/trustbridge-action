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
export interface SponsorshipInfo {
    /** Number of accounts this account is sponsoring (num_sponsoring from Horizon). */
    numSponsoring: number;
    /** Number of accounts sponsoring this account (num_sponsored from Horizon). */
    numSponsored: number;
}
export interface ValidationResult {
    valid: boolean;
    accountFunded: boolean;
    trustlineExists: boolean;
    xlmBalance: string;
    xlmReserveMet: boolean;
    trustlineLimit?: string;
    checks: CheckResultItem[];
    remediation?: string;
    /** Populated when the reserve was computed from a real account (not the unfunded/error paths). */
    reserveRequirement?: ReserveRequirement;
}
export declare function normalizeStellarAddress(address: string): string;
/**
 * Validates a Stellar "G..." address against the full StrKey policy: 56
 * characters from the StrKey base32 alphabet, the ed25519 public key
 * version byte, and a matching CRC-16/XMODEM checksum. A regex match alone
 * only confirms shape — many regex-valid strings are not real StrKeys
 * because their checksum bytes don't match the payload.
 */
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
export declare function parseMinXlmReserve(value: string): number;
export declare function parseTrustlineLimit(value: string): number;
export declare function estimateTrustlineSetupCost(): number;
export declare function formatXlmDeficit(required: bigint, actual: bigint): string;
export declare function formatAssetDeficit(required: bigint, actual: bigint): string;
export declare function runAccountChecks(account: HorizonAccount, config: CheckConfig): ValidationResult;
export declare function unfundedAccountResult(stellarAddress: string, config: CheckConfig): ValidationResult;
export declare function getFailedCheckLabels(result: ValidationResult): string[];
export declare function horizonFailureResult(message: string, config: CheckConfig): ValidationResult;
/** Subset of `HorizonAccount` needed to compute the protocol-accurate minimum balance. */
export interface SponsorAwareAccountFields {
    subentry_count: number;
    num_sponsoring?: number;
    num_sponsored?: number;
}
export interface ReserveRequirement {
    /** Final required balance: the greater of the protocol minimum and the configured floor. */
    required: number;
    actual: number;
    missing: string;
    met: boolean;
    /** Stellar protocol minimum computed from subentries and net sponsorship (CAP-0033). */
    protocolMinimum: number;
    /** The `min_xlm_reserve` input value, applied as a floor over the protocol minimum. */
    configuredFloor: number;
    subentryCount: number;
    numSponsoring: number;
    numSponsored: number;
}
/**
 * Computes the real Stellar protocol minimum balance for an account:
 * `(2 base reserves + subentries + num_sponsoring − num_sponsored) * base_reserve`.
 * Sponsored subentries don't count against the sponsoree's own reserve, and
 * subentries the account sponsors *for others* do — see CAP-0033. Clamped
 * to zero so a stale/inconsistent sponsorship snapshot can never go negative.
 */
export declare function computeProtocolMinReserve(account: SponsorAwareAccountFields): number;
/**
 * Builds the effective reserve requirement for an account: the Stellar
 * protocol minimum (sponsor-aware) with `configuredFloor` (`min_xlm_reserve`)
 * applied as a floor override, so maintainers can still require more than
 * the bare protocol minimum.
 */
export declare function buildReserveRequirement(configuredFloor: number, actual: number, account?: SponsorAwareAccountFields): ReserveRequirement;
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
