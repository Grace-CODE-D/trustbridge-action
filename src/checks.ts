import { HorizonAccount, getAssetBalance, getNativeBalance, hasTrustline, parseHorizonBalance, parseStroops, formatStroops } from './horizon';
import { escapeMarkdownInline, inlineCode } from './markdown';
import { buildChangeTrustLink, buildLobstrLink, inferStellarNetwork } from './links';
import { UnauthorizedTrustlinePolicy } from './inputs';

/** Stellar public network base reserve per ledger entry (XLM). */
export const STELLAR_BASE_RESERVE_XLM = 0.5;

/** Minimum balance required to activate a new account (XLM). */
export const STELLAR_MIN_ACCOUNT_BALANCE_XLM = 1;

export interface CheckConfig {
  assetCode: string;
  assetIssuer: string;
  minXlmReserve: string | number;
  minAssetBalance?: string | number;
  horizonUrl?: string;
  /** How to treat a trustline that exists but is not yet authorized by the issuer. Default: "warn". */
  unauthorizedTrustlinePolicy?: UnauthorizedTrustlinePolicy;
  /** When true, a clawback-enabled trustline fails the check instead of only warning. Default: false. */
  clawbackStrictMode?: boolean;
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
  /** Authorization state of the matched trustline, or undefined if not applicable (no trustline, or issuer field absent). */
  trustlineAuthorized?: boolean;
  /** Whether the matched trustline has clawback enabled, or undefined if not applicable. */
  clawbackEnabled?: boolean;
  xlmBalance: string;
  xlmReserveMet: boolean;
  assetBalance: string;
  assetBalanceMet: boolean;
  checks: CheckResultItem[];
  remediation?: string;
  /** Non-blocking warnings surfaced in the comment (e.g. unauthorized/clawback-enabled trustline under "warn" policy). */
  warnings?: string[];
}

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

/** Pattern to find any Stellar G-address embedded in free-form text. */
const STELLAR_ADDRESS_IN_TEXT_REGEX = /\bG[A-Z2-7]{55}\b/g;

export function normalizeStellarAddress(address: string): string {
  return address.trim();
}

export function isValidStellarAddress(address: string): boolean {
  return STELLAR_ADDRESS_REGEX.test(normalizeStellarAddress(address));
}

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
export function extractStellarAddressFromText(text: string | undefined | null): AddressExtractionResult {
  if (!text) {
    return { address: undefined, allAddresses: [] };
  }

  STELLAR_ADDRESS_IN_TEXT_REGEX.lastIndex = 0;
  const seen = new Set<string>();
  const allAddresses: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = STELLAR_ADDRESS_IN_TEXT_REGEX.exec(text)) !== null) {
    const candidate = match[0];
    if (isValidStellarAddress(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      allAddresses.push(candidate);
    }
  }

  return {
    address: allAddresses[0],
    allAddresses,
  };
}

export function validateStellarAddress(address: string): void {
  if (!address || !address.trim()) {
    throw new Error('stellar_address_input is required.');
  }
  if (!isValidStellarAddress(address)) {
    throw new Error(
      `Invalid Stellar address "${address}". Expected a 56-character public key starting with "G".`,
    );
  }
}

export function parseMinXlmReserve(value: string): string {
  const normalized = value.trim();
  const parsed = Number(normalized);
  if (!normalized || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`min_xlm_reserve must be a non-negative number. Received: "${value}"`);
  }
  return normalized;
}

export function parseMinAssetBalance(value: string): string | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`min_asset_balance must be a non-negative number. Received: "${value}"`);
  }
  return normalized;
}

export function estimateTrustlineSetupCost(): number {
  return STELLAR_MIN_ACCOUNT_BALANCE_XLM + STELLAR_BASE_RESERVE_XLM;
}

export function formatXlmDeficit(required: bigint, actual: bigint): string {
  const deficit = required > actual ? required - actual : 0n;
  return formatStroops(deficit);
}

export function formatAssetDeficit(required: bigint, actual: bigint): string {
  const deficit = required > actual ? required - actual : 0n;
  return formatStroops(deficit);
}

export function runAccountChecks(
  account: HorizonAccount,
  config: CheckConfig,
): ValidationResult {
  const xlmBalance = getNativeBalance(account);
  const xlmNumeric = parseHorizonBalance(xlmBalance);
  const trustlineExists = hasTrustline(account, config.assetCode, config.assetIssuer);
  const minXlmReserveStroops = parseStroops(config.minXlmReserve);
  const reserveRequirement = buildReserveRequirement(minXlmReserveStroops, xlmNumeric);
  const xlmReserveMet = reserveRequirement.met;
  // Uses isCreditBalance (not `asset_type !== 'native'`) so liquidity-pool
  // share balances alone don't make an account look like it "has
  // trustlines" for the purposes of this message.
  const hasAnyTrustlines = account.balances.some(isCreditBalance);

  const assetBalanceRaw = getAssetBalance(account, config.assetCode, config.assetIssuer);
  const assetBalanceNumeric = parseHorizonBalance(assetBalanceRaw);
  const minAssetBalanceRequired = config.minAssetBalance !== undefined ? config.minAssetBalance : '0';
  const minAssetBalanceStroops = parseStroops(minAssetBalanceRequired);
  const assetBalanceCheckEnabled = minAssetBalanceStroops > 0n;
  const assetBalanceRequirement = buildAssetBalanceRequirement(
    minAssetBalanceStroops,
    assetBalanceNumeric,
  );
  const assetBalanceMet = !assetBalanceCheckEnabled || assetBalanceRequirement.met;

  const safeAssetCode = escapeMarkdownInline(config.assetCode);

  let trustlineDetail: string;
  if (trustlineExistsRaw && isUnauthorized) {
    trustlineDetail = authorizationBlocks
      ? `Trustline for **${safeAssetCode}** exists but is **not authorized** by the issuer (${inlineCode(config.assetIssuer)}) — blocked by \`unauthorized_trustline_policy: fail\`.`
      : `Trustline for **${safeAssetCode}** (${inlineCode(config.assetIssuer)}) is configured, but **not yet authorized** by the issuer — transfers will fail until authorized.`;
  } else if (trustlineExistsRaw) {
    trustlineDetail = `Trustline for **${safeAssetCode}** (${inlineCode(config.assetIssuer)}) is configured.`;
  } else if (hasAnyTrustlines) {
    trustlineDetail = `Account has trustlines, but not for **${safeAssetCode}** issued by ${inlineCode(config.assetIssuer)}.`;
  } else {
    trustlineDetail = 'Account has **zero trustlines** — add a trustline before receiving this asset.';
  }

  const checks: CheckResultItem[] = [
    {
      passed: true,
      label: 'Account funded',
      detail: `Account ${inlineCode(account.account_id)} is active on the Stellar network.`,
    },
    {
      passed: trustlineExists,
      label: `${safeAssetCode} trustline`,
      detail: trustlineDetail,
    },
    {
      passed: xlmReserveMet,
      label: 'XLM reserve',
      detail: xlmReserveMet
        ? `Balance **${inlineCode(xlmBalance)} XLM** meets the minimum of **${config.minXlmReserve} XLM**.`
        : `Balance **${inlineCode(xlmBalance)} XLM** is below the required **${config.minXlmReserve} XLM**.`,
    },
  ];

  if (assetBalanceCheckEnabled) {
    const assetBalanceCheckDetail = trustlineExists
      ? assetBalanceRequirement.met
        ? `Balance **${inlineCode(assetBalanceRaw)} ${safeAssetCode}** meets the minimum of **${minAssetBalanceRequired} ${safeAssetCode}**.`
        : `Balance **${inlineCode(assetBalanceRaw)} ${safeAssetCode}** is below the required **${minAssetBalanceRequired} ${safeAssetCode}**. Deficit: **${assetBalanceRequirement.missing} ${safeAssetCode}**.`
      : `Cannot verify ${safeAssetCode} balance — trustline is not configured yet.`;
    checks.push({
      passed: assetBalanceMet || !trustlineExists,
      label: `${safeAssetCode} minimum balance`,
      detail: assetBalanceCheckDetail,
    });
  }

  const valid = checks.every((c) => c.passed);
  let remediation: string | undefined;

  if (!valid) {
    const network = inferStellarNetwork(config.horizonUrl ?? '');
    const steps: string[] = [];
    if (authorizationBlocks) {
      steps.push(
        `Ask the asset issuer (${inlineCode(config.assetIssuer)}) to authorize this trustline for ${inlineCode(account.account_id)}. The issuer has AUTHORIZATION_REQUIRED enabled, so a Change Trust operation alone is not enough — the issuer must submit a SetTrustLineFlags (or legacy AllowTrust) operation.`,
      );
    } else if (!trustlineExists) {
      steps.push(
        `Add a **${safeAssetCode}** trustline using [Stellar Laboratory](${buildChangeTrustLink(network)}) (Change Trust operation) or a wallet such as [LOBSTR](${buildLobstrLink()}).`,
      );
    }
    if (!xlmReserveMet) {
      steps.push(
        `Send at least **${reserveRequirement.missing} XLM** to ${inlineCode(account.account_id)} to meet the reserve requirement.`,
      );
    }
    if (assetBalanceCheckEnabled && !assetBalanceMet && trustlineExists) {
      steps.push(
        `Acquire at least **${assetBalanceRequirement.missing} ${safeAssetCode}** to meet the minimum asset balance requirement of **${minAssetBalanceRequired} ${safeAssetCode}**.`,
      );
    }
    remediation = steps.join('\n\n');
  }

  return {
    valid,
    accountFunded: true,
    trustlineExists,
    trustlineAuthorized,
    clawbackEnabled: trustlineExistsRaw ? clawbackEnabled : undefined,
    xlmBalance,
    xlmReserveMet,
    assetBalance: assetBalanceRaw,
    assetBalanceMet,
    checks,
    remediation,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

export function unfundedAccountResult(
  stellarAddress: string,
  config: CheckConfig,
): ValidationResult {
  const safeAssetCode = escapeMarkdownInline(config.assetCode);
  const safeAddress = inlineCode(stellarAddress);
  const network = inferStellarNetwork(config.horizonUrl ?? '');
  const assetBalanceCheckEnabled = Number(config.minAssetBalance ?? 0) > 0;

  const checks: CheckResultItem[] = [
    {
      passed: false,
      label: 'Account funded',
      detail: `Account ${safeAddress} was **not found** on Horizon — it may not be funded or activated yet.`,
    },
    {
      passed: false,
      label: `${safeAssetCode} trustline`,
      detail: 'Cannot verify trustline until the account exists.',
    },
    {
      passed: false,
      label: 'XLM reserve',
      detail: `Cannot verify XLM balance. Fund the account with at least **${config.minXlmReserve} XLM**.`,
    },
  ];

  if (assetBalanceCheckEnabled) {
    checks.push({
      passed: false,
      label: `${safeAssetCode} minimum balance`,
      detail: `Cannot verify ${safeAssetCode} balance. Fund the account and establish a trustline first.`,
    });
  }

  return {
    valid: false,
    accountFunded: false,
    trustlineExists: false,
    xlmBalance: '0',
    xlmReserveMet: false,
    assetBalance: '0',
    assetBalanceMet: false,
    checks,
    remediation: [
      `Activate ${safeAddress} by sending at least **${STELLAR_MIN_ACCOUNT_BALANCE_XLM} XLM** (Stellar minimum account balance).`,
      `Then add a **${safeAssetCode}** trustline via [Stellar Laboratory](${buildChangeTrustLink(network)}) or [LOBSTR](${buildLobstrLink()}).`,
      `Estimated setup cost: ~**${estimateTrustlineSetupCost()} XLM** (1 XLM base + 0.5 XLM per trustline reserve).`,
    ].join('\n\n'),
  };
}

export function getFailedCheckLabels(result: ValidationResult): string[] {
  return result.checks.filter((check) => !check.passed).map((check) => check.label);
}

/**
 * Reduces an error message to something safe to post in a public GitHub
 * comment: only the first line (never a multi-line stack trace) and capped
 * to a sane length. The underlying Error's full `.stack` is never passed
 * into this pipeline in the first place — callers only ever pass
 * `error.message` — but this is a defense-in-depth guard against a
 * message that itself happens to be multi-line or unexpectedly long.
 */
function sanitizeErrorMessageForComment(message: string): string {
  const firstLine = message.split(/\r?\n/)[0] ?? '';
  const MAX_LENGTH = 500;
  return firstLine.length > MAX_LENGTH ? `${firstLine.slice(0, MAX_LENGTH)}…` : firstLine;
}

export function horizonFailureResult(message: string, config: CheckConfig): ValidationResult {
  // `message` may originate from the configured Horizon endpoint's HTTP
  // response body (e.g. the `detail`/`title` fields of an error payload),
  // which is not trusted content — sanitize and escape it before it lands
  // in the Markdown comment so it can't dump a stack trace, inject
  // formatting/links, or break out of the comment structure.
  const safeMessage = escapeMarkdownInline(sanitizeErrorMessageForComment(message));
  const safeAssetCode = escapeMarkdownInline(config.assetCode);
  const assetBalanceCheckEnabled = Number(config.minAssetBalance ?? 0) > 0;

  const checks: CheckResultItem[] = [
    {
      passed: false,
      label: 'Horizon availability',
      detail: safeMessage,
    },
    {
      passed: false,
      label: `${safeAssetCode} trustline`,
      detail: 'Check could not be completed.',
    },
    {
      passed: false,
      label: 'XLM reserve',
      detail: 'Check could not be completed.',
    },
  ];

  if (assetBalanceCheckEnabled) {
    checks.push({
      passed: false,
      label: `${safeAssetCode} minimum balance`,
      detail: 'Check could not be completed.',
    });
  }

  return {
    valid: false,
    accountFunded: false,
    trustlineExists: false,
    xlmBalance: 'unknown',
    xlmReserveMet: false,
    assetBalance: 'unknown',
    assetBalanceMet: false,
    checks,
    remediation:
      'Horizon could not be reached. Retry later or verify your `horizon_url` input and network connectivity.',
  };
}

/**
 * Builds a result for a TLS/certificate verification failure connecting to
 * the configured Horizon endpoint (see `HorizonTlsError`). Kept distinct
 * from `horizonFailureResult` so the comment clearly attributes the
 * failure to the endpoint's transport/certificate configuration rather
 * than to the account or trustline being checked — this matters most for
 * private/enterprise Horizon mirrors, where a bad or expired certificate
 * is easy to misdiagnose as "the account isn't set up right."
 */
export function tlsFailureResult(message: string, config: CheckConfig): ValidationResult {
  const safeMessage = escapeMarkdownInline(sanitizeErrorMessageForComment(message));
  const safeAssetCode = escapeMarkdownInline(config.assetCode);

  const checks: CheckResultItem[] = [
    {
      passed: false,
      label: 'Horizon TLS / certificate verification',
      detail: safeMessage,
    },
    {
      passed: false,
      label: `${safeAssetCode} trustline`,
      detail: 'Check could not be completed — the Horizon TLS handshake failed before this account could be queried.',
    },
    {
      passed: false,
      label: 'XLM reserve',
      detail: 'Check could not be completed — the Horizon TLS handshake failed before this account could be queried.',
    },
  ];

  return {
    valid: false,
    accountFunded: false,
    trustlineExists: false,
    xlmBalance: 'unknown',
    xlmReserveMet: false,
    checks,
    remediation:
      'This is a TLS/certificate problem with the configured `horizon_url`, not an issue with the Stellar account. ' +
      'If you are using a private Horizon mirror, verify its certificate is valid, not expired, and signed by a CA trusted by the runner. ' +
      'See docs/USAGE.md for private-mirror setup guidance.',
  };
}

export interface ReserveRequirement {
  required: bigint;
  actual: bigint;
  missing: string;
  met: boolean;
}

export function buildReserveRequirement(required: bigint, actual: bigint): ReserveRequirement {
  return {
    required,
    actual,
    missing: formatXlmDeficit(required, actual),
    met: actual >= required,
  };
}

export interface AssetBalanceRequirement {
  required: bigint;
  actual: bigint;
  missing: string;
  met: boolean;
}

export function buildAssetBalanceRequirement(
  required: bigint,
  actual: bigint,
): AssetBalanceRequirement {
  return {
    required,
    actual,
    missing: formatAssetDeficit(required, actual),
    met: actual >= required,
  };
}

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
export function buildValidationGate(result: ValidationResult): ValidationGate {
  const failedLabels = getFailedCheckLabels(result);
  const failedChecks = failedLabels.length;
  const totalChecks = result.checks.length;
  return {
    ready: failedChecks === 0,
    totalChecks,
    passedChecks: totalChecks - failedChecks,
    failedChecks,
    failedLabels,
  };
}

// ---------------------------------------------------------------------------
// Wave #32: Reusable workflow examples for trustline, reserve, StrKey,
// multi-asset validation checks (Issue #32)
// ---------------------------------------------------------------------------

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
export function checkTrustlineExists(
  account: HorizonAccount,
  assetCode: string,
  assetIssuer: string,
): boolean {
  return hasTrustline(account, assetCode, assetIssuer);
}

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
export function checkReserveMet(
  account: HorizonAccount,
  minReserve: number,
): boolean {
  const xlmBalance = getNativeBalance(account);
  const parsed = parseHorizonBalance(xlmBalance);
  return parsed >= minReserve;
}

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
export function validateStrKeyFormat(address: string): boolean {
  const trimmed = address.trim();
  if (trimmed.length !== 56) return false;
  
  const prefix = trimmed.charAt(0);
  if (prefix !== 'G' && prefix !== 'C') return false;
  
  // StrKey uses base32 alphabet: A-Z, 2-7
  const strKeyRegex = /^[GC][A-Z2-7]{55}$/;
  return strKeyRegex.test(trimmed);
}

/**
 * Multi-asset trustline check configuration.
 */
export interface MultiAssetConfig {
  assetCode: string;
  assetIssuer: string;
  required: boolean; // if false, check is optional (warning only)
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
export function checkMultiAssetTrustlines(
  account: HorizonAccount,
  assets: MultiAssetConfig[],
): Array<{ asset: string; issuer: string; exists: boolean; required: boolean }> {
  return assets.map((cfg) => ({
    asset: cfg.assetCode,
    issuer: cfg.assetIssuer,
    exists: hasTrustline(account, cfg.assetCode, cfg.assetIssuer),
    required: cfg.required,
  }));
}

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
export function calculateRecommendedReserve(trustlineCount: number): number {
  return STELLAR_MIN_ACCOUNT_BALANCE_XLM + trustlineCount * STELLAR_BASE_RESERVE_XLM;
}

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
export function checkAccountSponsored(account: HorizonAccount): boolean {
  return account.num_sponsored > 0;
}

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
  trustlines: Array<{ asset: string; issuer: string; exists: boolean }>;
  sponsored: boolean;
  timestamp: string;
}

export function generateValidationReport(
  account: HorizonAccount,
  config: CheckConfig,
  additionalAssets: MultiAssetConfig[] = [],
): ValidationReport {
  const xlmBalance = getNativeBalance(account);
  const xlmParsed = parseHorizonBalance(xlmBalance);
  const trustlineCount = account.balances.filter((b) => b.asset_type !== 'native').length;
  const recommendedReserve = calculateRecommendedReserve(trustlineCount);
  
  const primaryTrustline = {
    asset: config.assetCode,
    issuer: config.assetIssuer,
    exists: hasTrustline(account, config.assetCode, config.assetIssuer),
  };
  
  const additionalTrustlineResults = checkMultiAssetTrustlines(account, additionalAssets).map(
    (r) => ({ asset: r.asset, issuer: r.issuer, exists: r.exists }),
  );
  
  return {
    address: account.account_id,
    strKeyValid: validateStrKeyFormat(account.account_id),
    accountFunded: true,
    xlmBalance,
    reserveStatus: {
      current: xlmParsed,
      required: Math.max(config.minXlmReserve, recommendedReserve),
      met: xlmParsed >= Math.max(config.minXlmReserve, recommendedReserve),
      deficit: formatXlmDeficit(Math.max(config.minXlmReserve, recommendedReserve), xlmParsed),
    },
    trustlines: [primaryTrustline, ...additionalTrustlineResults],
    sponsored: checkAccountSponsored(account),
    timestamp: new Date().toISOString(),
  };
}
