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
export declare function validateStellarAddress(address: string): void;
export declare function parseMinXlmReserve(value: string): number;
export declare function estimateTrustlineSetupCost(): number;
export declare function formatXlmDeficit(required: number, actual: number): string;
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
