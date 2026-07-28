import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  CheckConfig,
  STELLAR_BASE_RESERVE_XLM,
  STELLAR_MIN_ACCOUNT_BALANCE_XLM,
  buildValidationGate,
  ValidationResult,
  estimateTrustlineSetupCost,
} from './checks';
import {
  buildAccountViewerLink,
  buildChangeTrustLink,
  buildLobstrLink,
  buildSep0007PayLink,
  inferStellarNetwork,
} from './links';
import { inlineCode } from './markdown';
import { MetricsCollector } from './metrics';
import { Locale, getStrings } from './i18n';

/**
 * Semantic schema version embedded in every TrustBridge issue comment.
 * Bump when the comment body structure (sections, markers, remediation
 * shape, etc.) changes in a way that downstream consumers or future
 * versions of this action need to detect.
 */
export const COMMENT_SCHEMA_VERSION = '1.0.0';

export interface CommentConfig extends CheckConfig {
  stellarAddress: string;
  horizonUrl: string;
  failOnMissing?: boolean;
  waitUntilFunded?: boolean;
  waitUntilFundedTimeoutMs?: number;
  waitUntilFundedIntervalMs?: number;
  stickyComment?: boolean;
  /** Emit SEP-0007 wallet deep links (web+stellar:pay) in the comment. */
  sep0007DeepLinks?: boolean;
  /** Optional origin domain for SEP-0007 URIs (§3.4). */
  sep0007OriginDomain?: string;
  /**
   * When provided, a hardened metrics JSON block is appended to the comment
   * as a fenced code block. Callers should pass a fresh `MetricsCollector`
   * snapshot so the comment reflects the run that generated it.
   */
  metricsSnapshot?: MetricsCollector;
  /**
   * Locale for comment strings (e.g., 'en', 'es', 'pt').
   * Falls back to English if unset or invalid.
   */
  locale?: Locale;
}

export const TRUSTBRIDGE_FOOTER = '_Posted by [trustbridge-action](https://github.com/Stellar-TrustBridge/trustbridge-action)_';

/**
 * Legacy hidden marker (pre-schema-version). Kept for backward
 * compatibility in `findStickyComment` so comments posted by older
 * releases of the action are still eligible for upsert.
 */
export const STICKY_COMMENT_MARKER_LEGACY = '<!-- trustbridge-action:sticky-comment -->';

/**
 * Hidden marker embedded in every TrustBridge comment body. Includes the
 * comment schema version so future releases can detect the format of a
 * prior comment and decide whether to update it in place or post a new
 * one.
 */
export const STICKY_COMMENT_MARKER = `<!-- trustbridge-action:sticky-comment:schema-v${COMMENT_SCHEMA_VERSION} -->`;

function statusIcon(passed: boolean): string {
  return passed ? '✅' : '❌';
}

export function formatCommentBody(
  result: ValidationResult,
  config: CommentConfig,
): string {
  const stellarLabNetwork = inferStellarNetwork(config.horizonUrl);
  const gate = buildValidationGate(result);
  const locale = config.locale || 'en';
  const strings = getStrings(locale);

  const lines: string[] = [
    STICKY_COMMENT_MARKER,
    `<!-- trustbridge-action:schema-version:${COMMENT_SCHEMA_VERSION} -->`,
    `<!-- trustbridge-action:locale:${locale} -->`,
    `## ${strings.heading}`,
    '',
    `${strings.checkedAccount} ${inlineCode(config.stellarAddress)}`,
    `${strings.horizon} ${inlineCode(config.horizonUrl)}`,
    `${strings.asset} **${config.assetCode}** · Issuer: ${inlineCode(config.assetIssuer)}`,
    '',
    `### ${strings.resultsHeading}`,
    '',
  ];

  for (const check of result.checks) {
    lines.push(`- ${statusIcon(check.passed)} **${check.label}** — ${check.detail}`);
  }

  lines.push(
    '',
    `### ${strings.validationGateHeading}`,
    '',
    gate.ready
      ? `- ${strings.readyToProceed}`
      : `- ${strings.blockedBy} ${gate.failedLabels.join(', ')}`,
    `- ${strings.passedChecks} ${gate.passedChecks}/${gate.totalChecks}`,
    `- ${strings.failedChecks} ${gate.failedChecks}`,
    '',
    `### ${strings.balancesHeading}`,
    '',
    `- **${strings.xlmBalance}** ${result.xlmBalance === 'unknown' ? '_unknown_' : `\`${result.xlmBalance} XLM\``}`,
    `- **${strings.minimumRequired}** \`${config.minXlmReserve} XLM\``,
    '',
    `### ${strings.setupCostHeading}`,
    '',
    `- ${strings.minimumAccountBalance} **${STELLAR_MIN_ACCOUNT_BALANCE_XLM} XLM**`,
    `- ${strings.baseReservePerTrustline} **${STELLAR_BASE_RESERVE_XLM} XLM**`,
    `- ${strings.typicalMinimumToFund} **~${estimateTrustlineSetupCost()} XLM**`,
    '',
    `### ${strings.addTrustlineHeading}`,
    '',
    `- [${strings.viewAccountOnLab}](${buildAccountViewerLink(config.stellarAddress, stellarLabNetwork)})`,
    `- [${strings.openTransactionBuilder}](${buildChangeTrustLink(stellarLabNetwork)})`,
    `- [${strings.lobstrWallet}](${buildLobstrLink()}) — ${strings.lobstrDescription} **${config.assetCode}** from issuer \`${config.assetIssuer}\``,
  );

  // SEP-0007 wallet deep links (Issue #44)
  if (config.sep0007DeepLinks) {
    const payLink = buildSep0007PayLink({
      destination: config.stellarAddress,
      amount: String(STELLAR_MIN_ACCOUNT_BALANCE_XLM),
      msg: `Activate Stellar account for ${config.assetCode} trustline`,
      network: stellarLabNetwork,
      originDomain: config.sep0007OriginDomain || undefined,
    });
    lines.push(
      '',
      `### ${strings.sepWalletActionsHeading}`,
      '',
      `_${strings.sepWalletActionsDescription}_`,
      '',
      `- [${strings.sendXlmToActivate.replace('{amount}', String(STELLAR_MIN_ACCOUNT_BALANCE_XLM))}](${payLink})`,
    );
  }

  if (result.remediation) {
    lines.push('', `### ${strings.remediationHeading}`, '', result.remediation);
  }

  lines.push(
    '',
    `### ${strings.configurationSummaryHeading}`,
    '',
    `| ${strings.inputColumn} | ${strings.valueColumn} |`,
    `| --- | --- |`,
    `| \`fail_on_missing\` | ${config.failOnMissing === undefined ? '_default (true)_' : config.failOnMissing ? strings.failOnMissingTrue : strings.failOnMissingFalse} |`,
    `| \`sticky_comment\` | ${config.stickyComment === undefined ? '_default (true)_' : config.stickyComment ? strings.stickyCommentTrue : strings.stickyCommentFalse} |`,
    `| \`wait_until_funded\` | ${config.waitUntilFunded ? strings.waitUntilFundedTrue : strings.waitUntilFundedFalse} |`,
  );

  if (config.waitUntilFunded) {
    const timeout = config.waitUntilFundedTimeoutMs ?? 120000;
    const interval = config.waitUntilFundedIntervalMs ?? 5000;
    lines.push(
      `| \`wait_until_funded_timeout_ms\` | ${strings.waitUntilFundedTimeoutMs.replace('{ms}', String(timeout))} |`,
      `| \`wait_until_funded_interval_ms\` | ${strings.waitUntilFundedIntervalMs.replace('{ms}', String(interval))} |`,
    );
  }

  lines.push(
    '',
    `### ${strings.outputsHeading}`,
    '',
    `_${strings.outputsDescription}_`,
    '',
    `| ${strings.outputColumn} | ${strings.valueRunColumn} | ${strings.descriptionColumn} |`,
    `| --- | --- | --- |`,
    `| \`account_funded\` | \`${String(result.accountFunded)}\` | ${strings.accountFundedOutput} |`,
    `| \`trustline_exists\` | \`${String(result.trustlineExists)}\` | ${strings.trustlineExistsOutput.replace('{assetCode}', config.assetCode)} |`,
    `| \`xlm_balance\` | \`${result.xlmBalance}\` | ${strings.xlmBalanceOutput} |`,
    `| \`comment_url\` | _set after posting_ | ${strings.commentUrlOutput} |`,
  );

  // Hardened metrics JSON export (Issue #33)
  if (config.metricsSnapshot) {
    const metricsJson = buildHardenedMetricsJson(config.metricsSnapshot);
    lines.push(
      '',
      `### ${strings.metricsHeading}`,
      '',
      `_${strings.metricsDescription}_`,
      '',
      '```json',
      metricsJson,
      '```',
    );
  }

  lines.push(
    '',
    '---',
    TRUSTBRIDGE_FOOTER,
  );

  return lines.join('\n');
}

/**
 * Build a hardened metrics JSON string safe for embedding in a GitHub issue
 * comment.
 *
 * "Hardened" means:
 *   1. Only structural/aggregate fields are included (no raw balances, no
 *      account addresses, no Horizon URLs).
 *   2. The JSON is produced via `JSON.stringify` with a replacer so
 *      unintended fields cannot sneak in via future `MetricsCollector`
 *      additions.
 *   3. The output is size-capped at `MAX_METRICS_JSON_BYTES`; if exceeded,
 *      a truncation notice replaces the body so the comment never exceeds
 *      GitHub's comment size limit.
 *
 * @internal Exported for testing.
 */
export const MAX_METRICS_JSON_BYTES = 4096;

export function buildHardenedMetricsJson(metrics: MetricsCollector): string {
  const summary = metrics.getSummary();

  // Strip metric tags entirely — tags may contain contract addresses.
  const safeSummary = {
    totalMetrics: summary.totalMetrics,
    counters: summary.counters,
    metrics: summary.metrics.map((m) => ({
      name: m.name,
      value: m.value,
      unit: m.unit,
      timestamp: m.timestamp,
      // tags deliberately omitted
    })),
  };

  let json: string;
  try {
    json = JSON.stringify(safeSummary, null, 2);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: `metrics serialisation failed: ${message}` });
  }

  if (Buffer.byteLength(json, 'utf8') > MAX_METRICS_JSON_BYTES) {
    const truncated = {
      totalMetrics: safeSummary.totalMetrics,
      counters: safeSummary.counters,
      truncated: true,
      note: `Metrics body exceeded ${MAX_METRICS_JSON_BYTES} bytes and was omitted.`,
    };
    return JSON.stringify(truncated, null, 2);
  }

  return json;
}

export interface UpsertCommentOptions {
  /**
   * When true (default), find and update TrustBridge's previous comment on
   * the issue instead of posting a new one every run. Falls back to
   * creating a new comment when no prior comment is found, or when the
   * lookup itself fails (e.g. transient GitHub API error).
   */
  sticky?: boolean;
}

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * Returns true when a comment body matches any of the TrustBridge
 * identifiers: the current versioned sticky marker, the legacy marker
 * (pre-schema-version), or the TrustBridge footer. Matching on any of
 * these provides defense-in-depth across upgrades and accidental
 * marker drift.
 */
export function isTrustBridgeComment(body: string | undefined | null): boolean {
  if (!body) return false;
  return (
    body.includes(STICKY_COMMENT_MARKER) ||
    body.includes(STICKY_COMMENT_MARKER_LEGACY) ||
    body.includes(TRUSTBRIDGE_FOOTER)
  );
}

/**
 * Find TrustBridge's previous sticky comment on the issue, if any.
 * Paginates through every comment so the marker is found even on
 * high-traffic issues with 100+ comments.
 *
 * Matches on the current versioned marker, the legacy marker, and the
 * action footer so comments posted by older releases are still eligible
 * for upsert.
 */
export async function findStickyComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<number | undefined> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });

  const existing = comments.find((comment) => isTrustBridgeComment(comment.body));
  return existing?.id;
}

export async function postIssueComment(
  token: string,
  body: string,
  options: UpsertCommentOptions = {},
): Promise<string | undefined> {
  const sticky = options.sticky ?? true;
  const context = github.context;
  const issueNumber = context.payload.issue?.number;

  if (!issueNumber) {
    core.warning(
      'No issue context found — skipping comment. This action posts comments on `issues` events.',
    );
    return undefined;
  }

  const octokit = github.getOctokit(token);
  const { owner, repo } = context.repo;

  let existingCommentId: number | undefined;
  if (sticky) {
    try {
      existingCommentId = await findStickyComment(octokit, owner, repo, issueNumber);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(
        `Could not look up existing TrustBridge comment, falling back to a new comment: ${message}`,
      );
    }
  }

  if (existingCommentId) {
    const response = await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingCommentId,
      body,
    });

    const commentUrl = response.data.html_url;
    core.info(`Updated existing TrustBridge comment on issue #${issueNumber}.`);
    return commentUrl;
  }

  const response = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });

  const commentUrl = response.data.html_url;
  core.info(`Posted TrustBridge comment on issue #${issueNumber}.`);
  return commentUrl;
}
