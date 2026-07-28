import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';

import { ValidationResult } from './checks';
import { generateBadgeSnippets } from './badge';

export interface ActionOutputs {
  // Legacy outputs — kept for backward compatibility
  trustline_exists: string;
  xlm_balance: string;
  account_funded: string;
  comment_url: string;
  readiness_badge_markdown: string;
  readiness_badge_url: string;
}

export function toActionOutputs(result: ValidationResult, commentUrl?: string): ActionOutputs {
  const badgeSnippets = generateBadgeSnippets(result);
  return {
    // Legacy outputs
    trustline_exists: String(result.trustlineExists),
    xlm_balance: result.xlmBalance,
    account_funded: String(result.accountFunded),
    comment_url: commentUrl ?? '',
    readiness_badge_markdown: badgeSnippets.markdown,
    readiness_badge_url: badgeSnippets.url,
  };
}

export function setValidationOutputs(
  result: ValidationResult,
  commentUrl?: string,
  multiAssetResults?: AssetTrustlineResult[],
): void {
  const outputs = toActionOutputs(result, commentUrl, multiAssetResults);
  for (const [name, value] of Object.entries(outputs)) {
    core.setOutput(name, value);
  }
}

export interface WriteValidationJsonOptions {
  result: ValidationResult;
  stellarAddress: string;
  assetCode: string;
  assetIssuer: string;
  horizonUrl?: string;
  outputPath: string;
  delta?: ValidationDelta | null;
  privacyMode?: boolean;
  workspaceRoot?: string;
}

/**
 * Write a structured `validation.json` artifact for security review and
 * cross-run delta comparison. Never includes `github_token` or auth headers.
 */
export function writeValidationJson(options: WriteValidationJsonOptions): ValidationArtifact {
  const buildOpts: BuildValidationArtifactOptions = {
    result: options.result,
    stellarAddress: options.stellarAddress,
    assetCode: options.assetCode,
    assetIssuer: options.assetIssuer,
    horizonUrl: options.horizonUrl,
    delta: options.delta,
    privacyMode: options.privacyMode,
  };

  const payload = buildValidationArtifact(buildOpts);
  const root = options.workspaceRoot || process.env.GITHUB_WORKSPACE || process.cwd();
  const absolutePath = path.isAbsolute(options.outputPath)
    ? options.outputPath
    : path.resolve(root, options.outputPath);

  const dir = path.dirname(absolutePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(absolutePath, JSON.stringify(payload, null, 2), 'utf-8');
  core.info(`Wrote structured validation artifact to ${absolutePath}`);
  return payload;
}
