import { HorizonAccount, getNativeBalance, hasTrustline, getTrustlineLimit, parseHorizonBalance } from './horizon';
import { escapeMarkdownInline, inlineCode } from './markdown';
import {
  buildChangeTrustLink,
  buildLobstrLink,
  canonicalHorizonUrl,
  inferStellarNetwork,
  oppositeNetwork,
  StellarNetwork,
} from './links';

/** Stellar public network base reserve per ledger entry (XLM). */
export const STELLAR_BASE_RESERVE_XLM = 0.5;

/** Minimum balance required to activate a new account (XLM). */
export const STELLAR_MIN_ACCOUNT_BALANCE_XLM = 1;

export interface CheckConfig {
  assetCode: string;
  assetIssuer: string;
  minXlmReserve: number;
  minTrustlineLimit?: number; // Optional minimum trustline limit (Issue #140)
  horizonUrl?: string;
  /** How to treat a trustline that exists but is not yet authorized by the issuer. Default: "warn". */
  unauthorizedTrustlinePolicy?: UnauthorizedTrustlinePolicy;
  /** When true, a clawback-enabled trustline fails the check instead of only warning. Default: false. */
  clawbackStrictMode?: boolean;
}

// ---------------------------------------------------------------------------
// #144 — Cross-network detection
// ---------------------------------------------------------------------------

/**
 * Hint passed in from the caller when a 404 is received to indicate that the
 * same address was found active on a **different** network (e.g. the address
 * exists on testnet but the workflow is pointed at mainnet Horizon, or vice
 * versa).
 *
 * When present, unfunded/not-found error messages are augmented with a clear
 * cross-network remediation so contributors understand they need to either
 * fund on the correct network or switch `horizon_url`.
 */
export interface NetworkMismatchHint {
  /** Network the configured Horizon URL resolves to. */
  configuredNetwork: StellarNetwork;
  /** Network on which the address *was* found active. */
  activeOnNetwork: StellarNetwork;
}

/**
 * Detect whether a Stellar address that returned 404 on the primary Horizon
 * URL is actually active on the opposite network.
 *
 * Returns a `NetworkMismatchHint` when a mismatch is confirmed, or
 * `undefined` when there is no evidence of a mismatch (either no cross-check
 * was performed or the address is genuinely unfunded everywhere).
 *
 * @param configuredHorizonUrl  The `horizon_url` input value.
 * @param stellarAddress        The 56-char G-address that returned 404.
 * @param fetchFn               Optional injected fetch (for testing).
 */
export async function detectNetworkMismatch(
  configuredHorizonUrl: string,
  stellarAddress: string,
  fetchFn?: (url: string, init?: RequestInit) => Promise<{ status: number }>,
): Promise<NetworkMismatchHint | undefined> {
  const configuredNetwork = inferStellarNetwork(configuredHorizonUrl);
  const altNetwork = oppositeNetwork(configuredNetwork);
  const altHorizonUrl = canonicalHorizonUrl(altNetwork);
  const checkUrl = `${altHorizonUrl}/accounts/${stellarAddress}`;

  try {
    const fetcher = fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    const response = await fetcher(checkUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });

    if (response.status === 200) {
      return { configuredNetwork, activeOnNetwork: altNetwork };
    }
    // 404 means genuinely not found on alt network — no mismatch evidence
    return undefined;
  } catch {
    // Network error or timeout — can't determine, so no hint
    return undefined;
  }
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
  /** Authorization state of the matched trustline, or undefined if not applicable (no trustline, or issuer field absent). */
  trustlineAuthorized?: boolean;
  /** Whether the matched trustline has clawback enabled, or undefined if not applicable. */
  clawbackEnabled?: boolean;
  xlmBalance: string;
  xlmReserveMet: boolean;
  trustlineLimit?: string; // Actual trustline limit for the asset (Issue #140)
  checks: CheckResultItem[];
  remediation?: string;
  /** Populated when the reserve was computed from a real account (not the unfunded/error paths). */
  reserveRequirement?: ReserveRequirement;
}

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

/** RFC4648 base32 alphabet used by Stellar's StrKey encoding (no padding). */
const STRKEY_BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** StrKey version byte for an ed25519 public key ("G..." address): 6 << 3. */
const STRKEY_VERSION_BYTE_ED25519_PUBLIC_KEY = 0x30;

/**
 * Decodes an RFC4648 base32 string (no padding) into raw bytes, as used by
 * Stellar's StrKey encoding. Returns `null` if the input contains
 * characters outside the StrKey alphabet.
 */
function base32Decode(input: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of input) {
    const index = STRKEY_BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      return null;
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }

  return Uint8Array.from(bytes);
}

/**
 * CRC-16/XMODEM (poly 0x1021, init 0x0000, no reflect, no xorout) — the
 * checksum algorithm StrKey appends (little-endian) after the version byte
 * and payload.
 */
function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function normalizeStellarAddress(address: string): string {
  return address.trim();
}

/**
 * Validates a Stellar "G..." address against the full StrKey policy: 56
 * characters from the StrKey base32 alphabet, the ed25519 public key
 * version byte, and a matching CRC-16/XMODEM checksum. A regex match alone
 * only confirms shape — many regex-valid strings are not real StrKeys
 * because their checksum bytes don't match the payload.
 */
export function isValidStellarAddress(address: string): boolean {
  const trimmed = normalizeStellarAddress(address);
  if (!STELLAR_ADDRESS_REGEX.test(trimmed)) {
    return false;
  }

  const decoded = base32Decode(trimmed);
  // 1 version byte + 32-byte ed25519 payload + 2-byte checksum.
  if (!decoded || decoded.length !== 35) {
    return false;
  }

  if (decoded[0] !== STRKEY_VERSION_BYTE_ED25519_PUBLIC_KEY) {
    return false;
  }

  const versionAndPayload = decoded.subarray(0, 33);
  const expectedChecksum = crc16xmodem(versionAndPayload);
  const actualChecksum = decoded[33] | (decoded[34] << 8);

  return expectedChecksum === actualChecksum;
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
      `Invalid Stellar address "${address}". Expected a 56-character ed25519 public key ` +
        'starting with "G" with a valid StrKey checksum.',
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

export function parseTrustlineLimit(value: string): number {
  const normalized = value.trim();
  const parsed = Number(normalized);
  if (!normalized || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`min_trustline_limit must be a non-negative number. Received: "${value}"`);
  }
  return parsed;
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

/**
 * Renders the sponsor-aware reserve math behind a `ReserveRequirement` as a
 * short human-readable clause, e.g.
 * "protocol minimum **1.5 XLM** = (2 + 1 subentry) × 0.5 XLM, floor **1.5 XLM**".
 */
function explainReserveRequirement(reserve: ReserveRequirement): string {
  const sponsorClause =
    reserve.numSponsoring !== 0 || reserve.numSponsored !== 0
      ? ` + ${reserve.numSponsoring} sponsoring − ${reserve.numSponsored} sponsored`
      : '';
  const subentryWord = reserve.subentryCount === 1 ? 'subentry' : 'subentries';
  const formula = `(2 + ${reserve.subentryCount} ${subentryWord}${sponsorClause}) × ${STELLAR_BASE_RESERVE_XLM} XLM`;
  return `protocol minimum **${reserve.protocolMinimum} XLM** = ${formula}, floor **${reserve.configuredFloor} XLM**`;
}

export function runAccountChecks(
  account: HorizonAccount,
  config: CheckConfig,
): ValidationResult {
  const xlmBalance = getNativeBalance(account);
  const xlmNumeric = parseHorizonBalance(xlmBalance);
  const trustlineExists = hasTrustline(account, config.assetCode, config.assetIssuer);
  const reserveRequirement = buildReserveRequirement(config.minXlmReserve, xlmNumeric, account);
  const xlmReserveMet = reserveRequirement.met;
  const hasAnyTrustlines = account.balances.some((b) => isCreditBalance(b));

  const safeAssetCode = escapeMarkdownInline(config.assetCode);
  const reserveExplanation = explainReserveRequirement(reserveRequirement);

  // Get trustline limit for the asset (Issue #140)
  const trustlineLimit = getTrustlineLimit(account, config.assetCode, config.assetIssuer);
  const trustlineLimitNumeric = parseHorizonBalance(trustlineLimit);
  const trustlineLimitMet = !config.minTrustlineLimit || trustlineLimitNumeric >= config.minTrustlineLimit;

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
        ? `Balance **${inlineCode(xlmBalance)} XLM** meets the required **${reserveRequirement.required} XLM** — ${reserveExplanation}.`
        : `Balance **${inlineCode(xlmBalance)} XLM** is below the required **${reserveRequirement.required} XLM** — ${reserveExplanation}.`,
    },
  ];

  // Add trustline limit check if configured (Issue #140)
  if (config.minTrustlineLimit !== undefined) {
    checks.push({
      passed: trustlineExists && trustlineLimitMet,
      label: 'Trustline limit',
      detail: trustlineExists
        ? trustlineLimitMet
          ? `Trustline limit is **${inlineCode(trustlineLimit)} ${safeAssetCode}** (minimum required: **${config.minTrustlineLimit} ${safeAssetCode}**).`
          : `Trustline limit is **${inlineCode(trustlineLimit)} ${safeAssetCode}** but **${config.minTrustlineLimit} ${safeAssetCode}** is required.`
        : `Cannot verify trustline limit (${safeAssetCode} trustline does not exist).`,
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
    if (trustlineExists && !trustlineLimitMet && config.minTrustlineLimit) {
      steps.push(
        `Increase the ${safeAssetCode} trustline limit to at least **${config.minTrustlineLimit} ${safeAssetCode}** using [Stellar Laboratory](${buildChangeTrustLink(network)}) (Manage Trust operation) or a wallet. Current limit is **${inlineCode(trustlineLimit)} ${safeAssetCode}**.`,
      );
    }
    remediation = steps.join('\n\n');
  }

  // Extract sponsorship info from account (Issue #141)
  const sponsorshipInfo: SponsorshipInfo = {
    numSponsoring: account.num_sponsoring ?? 0,
    numSponsored: account.num_sponsored ?? 0,
  };

  return {
    valid,
    accountFunded: true,
    trustlineExists,
    trustlineAuthorized,
    clawbackEnabled: trustlineExistsRaw ? clawbackEnabled : undefined,
    xlmBalance,
    xlmReserveMet,
    trustlineLimit,
    checks,
    remediation,
    reserveRequirement,
  };
}

export function unfundedAccountResult(
  stellarAddress: string,
  config: CheckConfig,
  mismatchHint?: NetworkMismatchHint,
): ValidationResult {
  const safeAssetCode = escapeMarkdownInline(config.assetCode);
  const safeAddress = inlineCode(stellarAddress);
  const network = inferStellarNetwork(config.horizonUrl ?? '');
  const assetBalanceCheckEnabled = Number(config.minAssetBalance ?? 0) > 0;

  // Build the "not found" detail, extended with mismatch context when available
  let notFoundDetail = `Account ${safeAddress} was **not found** on Horizon — it may not be funded or activated yet.`;
  if (mismatchHint) {
    const altUrl = canonicalHorizonUrl(mismatchHint.activeOnNetwork);
    notFoundDetail =
      `Account ${safeAddress} was **not found** on the **${mismatchHint.configuredNetwork}** network` +
      ` but **is active on ${mismatchHint.activeOnNetwork}** (${altUrl}).` +
      ` This looks like a network mismatch — ensure \`horizon_url\` points at the correct network.`;
  }

  const checks: CheckResultItem[] = [
    {
      passed: false,
      label: 'Account funded',
      detail: notFoundDetail,
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

  // Base remediation steps
  const remediationSteps = [
    `Activate ${safeAddress} by sending at least **${STELLAR_MIN_ACCOUNT_BALANCE_XLM} XLM** (Stellar minimum account balance).`,
    `Then add a **${safeAssetCode}** trustline via [Stellar Laboratory](${buildChangeTrustLink(network)}) or [LOBSTR](${buildLobstrLink()}).`,
    `Estimated setup cost: ~**${estimateTrustlineSetupCost()} XLM** (1 XLM base + 0.5 XLM per trustline reserve).`,
  ];

  // Prepend network-mismatch guidance when detected so it's the first thing a
  // contributor reads.
  if (mismatchHint) {
    const correctUrl = canonicalHorizonUrl(mismatchHint.configuredNetwork);
    const altUrl = canonicalHorizonUrl(mismatchHint.activeOnNetwork);
    remediationSteps.unshift(
      `⚠️ **Network mismatch detected.** The address is active on **${mismatchHint.activeOnNetwork}** (${altUrl})` +
      ` but your workflow is configured to check the **${mismatchHint.configuredNetwork}** network (${correctUrl}).` +
      ` Either:\n` +
      `  1. Fund this address on **${mismatchHint.configuredNetwork}**, or\n` +
      `  2. Update \`horizon_url\` to \`${altUrl}\` if you intended to check ${mismatchHint.activeOnNetwork}.`,
    );
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
    sponsorshipInfo: { numSponsoring: 0, numSponsored: 0 },
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
      'Horizon could not be reached. Retry later or verify your `horizon_url` input and network connectivity.',
    sponsorshipInfo: { numSponsoring: 0, numSponsored: 0 },
  };
}

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
export function computeProtocolMinReserve(account: SponsorAwareAccountFields): number {
  const numSponsoring = account.num_sponsoring ?? 0;
  const numSponsored = account.num_sponsored ?? 0;
  const reserveEntries = 2 + account.subentry_count + numSponsoring - numSponsored;
  return Math.max(0, reserveEntries) * STELLAR_BASE_RESERVE_XLM;
}

/**
 * Builds the effective reserve requirement for an account: the Stellar
 * protocol minimum (sponsor-aware) with `configuredFloor` (`min_xlm_reserve`)
 * applied as a floor override, so maintainers can still require more than
 * the bare protocol minimum.
 */
export function buildReserveRequirement(
  configuredFloor: number,
  actual: number,
  account?: SponsorAwareAccountFields,
): ReserveRequirement {
  const protocolMinimum = account ? computeProtocolMinReserve(account) : 0;
  const required = Math.max(protocolMinimum, configuredFloor);
  return {
    required,
    actual,
    missing: formatXlmDeficit(required, actual),
    met: actual >= required,
    protocolMinimum,
    configuredFloor,
    subentryCount: account?.subentry_count ?? 0,
    numSponsoring: account?.num_sponsoring ?? 0,
    numSponsored: account?.num_sponsored ?? 0,
  };
}

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
export function runMultiAssetChecks(
  account: HorizonAccount,
  assets: Array<{ assetCode: string; assetIssuer: string }>,
): { results: AssetTrustlineResult[]; allTrustlinesExist: boolean } {
  const results: AssetTrustlineResult[] = assets.map((a) => ({
    assetCode: a.assetCode,
    assetIssuer: a.assetIssuer,
    trustlineExists: hasTrustline(account, a.assetCode, a.assetIssuer),
  }));
  return {
    results,
    allTrustlinesExist: results.every((r) => r.trustlineExists),
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
