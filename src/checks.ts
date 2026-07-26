import { HorizonAccount, getAssetBalance, getNativeBalance, hasTrustline, parseHorizonBalance, parseStroops, formatStroops } from './horizon';
import { escapeMarkdownInline, inlineCode } from './markdown';
import { buildChangeTrustLink, buildLobstrLink, inferStellarNetwork } from './links';

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

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

export function normalizeStellarAddress(address: string): string {
  return address.trim();
}

export function isValidStellarAddress(address: string): boolean {
  return STELLAR_ADDRESS_REGEX.test(normalizeStellarAddress(address));
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
  const hasAnyTrustlines = account.balances.some((b) => b.asset_type !== 'native');

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
    xlmBalance,
    xlmReserveMet,
    assetBalance: assetBalanceRaw,
    assetBalanceMet,
    checks,
    remediation,
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

export function horizonFailureResult(message: string, config: CheckConfig): ValidationResult {
  // `message` may originate from the configured Horizon endpoint's HTTP
  // response body (e.g. the `detail`/`title` fields of an error payload),
  // which is not trusted content — escape it before it lands in the
  // Markdown comment so it can't inject formatting, links, or break out of
  // the comment structure.
  const safeMessage = escapeMarkdownInline(message);
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
