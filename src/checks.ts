import { HorizonAccount, getNativeBalance, hasTrustline, parseHorizonBalance } from './horizon';
import { escapeMarkdownInline, inlineCode } from './markdown';
import { buildChangeTrustLink, buildLobstrLink, inferStellarNetwork } from './links';

/** Stellar public network base reserve per ledger entry (XLM). */
export const STELLAR_BASE_RESERVE_XLM = 0.5;

/** Minimum balance required to activate a new account (XLM). */
export const STELLAR_MIN_ACCOUNT_BALANCE_XLM = 1;

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

export function parseMinXlmReserve(value: string): number {
  const normalized = value.trim();
  const parsed = Number(normalized);
  if (!normalized || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`min_xlm_reserve must be a non-negative number. Received: "${value}"`);
  }
  return parsed;
}

export function estimateTrustlineSetupCost(): number {
  return STELLAR_MIN_ACCOUNT_BALANCE_XLM + STELLAR_BASE_RESERVE_XLM;
}

export function formatXlmDeficit(required: number, actual: number): string {
  return Math.max(0, required - actual).toFixed(7);
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
  const hasAnyTrustlines = account.balances.some((b) => b.asset_type !== 'native');

  const safeAssetCode = escapeMarkdownInline(config.assetCode);
  const reserveExplanation = explainReserveRequirement(reserveRequirement);

  const checks: CheckResultItem[] = [
    {
      passed: true,
      label: 'Account funded',
      detail: `Account ${inlineCode(account.account_id)} is active on the Stellar network.`,
    },
    {
      passed: trustlineExists,
      label: `${safeAssetCode} trustline`,
      detail: trustlineExists
        ? `Trustline for **${safeAssetCode}** (${inlineCode(config.assetIssuer)}) is configured.`
        : hasAnyTrustlines
          ? `Account has trustlines, but not for **${safeAssetCode}** issued by ${inlineCode(config.assetIssuer)}.`
          : 'Account has **zero trustlines** — add a trustline before receiving this asset.',
    },
    {
      passed: xlmReserveMet,
      label: 'XLM reserve',
      detail: xlmReserveMet
        ? `Balance **${inlineCode(xlmBalance)} XLM** meets the required **${reserveRequirement.required} XLM** — ${reserveExplanation}.`
        : `Balance **${inlineCode(xlmBalance)} XLM** is below the required **${reserveRequirement.required} XLM** — ${reserveExplanation}.`,
    },
  ];

  const valid = checks.every((c) => c.passed);
  let remediation: string | undefined;

  if (!valid) {
    const network = inferStellarNetwork(config.horizonUrl ?? '');
    const steps: string[] = [];
    if (!trustlineExists) {
      steps.push(
        `Add a **${safeAssetCode}** trustline using [Stellar Laboratory](${buildChangeTrustLink(network)}) (Change Trust operation) or a wallet such as [LOBSTR](${buildLobstrLink()}).`,
      );
    }
    if (!xlmReserveMet) {
      steps.push(
        `Send at least **${reserveRequirement.missing} XLM** to ${inlineCode(account.account_id)} to meet the reserve requirement.`,
      );
    }
    remediation = steps.join('\n\n');
  }

  return {
    valid,
    accountFunded: true,
    trustlineExists,
    xlmBalance,
    xlmReserveMet,
    checks,
    remediation,
    reserveRequirement,
  };
}

export function unfundedAccountResult(
  stellarAddress: string,
  config: CheckConfig,
): ValidationResult {
  const safeAssetCode = escapeMarkdownInline(config.assetCode);
  const safeAddress = inlineCode(stellarAddress);
  const network = inferStellarNetwork(config.horizonUrl ?? '');

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

  return {
    valid: false,
    accountFunded: false,
    trustlineExists: false,
    xlmBalance: '0',
    xlmReserveMet: false,
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

export function horizonFailureResult(message: string, config: CheckConfig): ValidationResult {
  // `message` may originate from the configured Horizon endpoint's HTTP
  // response body (e.g. the `detail`/`title` fields of an error payload),
  // which is not trusted content — escape it before it lands in the
  // Markdown comment so it can't inject formatting, links, or break out of
  // the comment structure.
  const safeMessage = escapeMarkdownInline(message);
  const safeAssetCode = escapeMarkdownInline(config.assetCode);

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

  return {
    valid: false,
    accountFunded: false,
    trustlineExists: false,
    xlmBalance: 'unknown',
    xlmReserveMet: false,
    checks,
    remediation:
      'Horizon could not be reached. Retry later or verify your `horizon_url` input and network connectivity.',
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
