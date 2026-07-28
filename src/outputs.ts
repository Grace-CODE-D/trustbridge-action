import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';

import { ValidationResult } from './checks';
import {
  BuildValidationArtifactOptions,
  ValidationArtifact,
  ValidationDelta,
  buildValidationArtifact,
} from './delta';

export interface ActionOutputs {
  // Legacy outputs — kept for backward compatibility
  trustline_exists: string;
  xlm_balance: string;
  account_funded: string;
  comment_url: string;
  /** JSON array of per-asset trustline statuses when assets_json is used. */
  assets_trustline_status: string;
  /** "true" if all assets in assets_json have trustlines, "false" otherwise, "" when not used. */
  trustlines_summary: string;
}

export function toActionOutputs(
  result: ValidationResult,
  commentUrl?: string,
  multiAssetResults?: AssetTrustlineResult[],
): ActionOutputs {
  const assetsTrustlineStatus =
    multiAssetResults && multiAssetResults.length > 0
      ? JSON.stringify(multiAssetResults)
      : '';
  const trustlinesSummary =
    multiAssetResults && multiAssetResults.length > 0
      ? String(multiAssetResults.every((r) => r.trustlineExists))
      : '';
  return {
    // Legacy outputs
    trustline_exists: String(result.trustlineExists),
    xlm_balance: result.xlmBalance,
    account_funded: String(result.accountFunded),
    comment_url: commentUrl ?? '',
    assets_trustline_status: assetsTrustlineStatus,
    trustlines_summary: trustlinesSummary,
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
