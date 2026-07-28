import * as core from '@actions/core';

import * as fs from 'fs';
import * as path from 'path';

import { ValidationResult, CheckConfig, buildValidationGate } from './checks';

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

export function writeValidationJson(
  result: ValidationResult,
  config: CheckConfig & { stellarAddress: string },
  outputPath: string,
): void {
  const payload = {
    timestamp: new Date().toISOString(),
    address: config.stellarAddress,
    asset: {
      code: config.assetCode,
      issuer: config.assetIssuer,
    },
    horizonUrl: config.horizonUrl,
    readiness: buildValidationGate(result),
    checks: result.checks,
    balances: {
      xlm: result.xlmBalance,
    },
  };

  const absolutePath = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd(), outputPath);
  fs.writeFileSync(absolutePath, JSON.stringify(payload, null, 2), 'utf-8');
  core.info(`Wrote structured validation artifact to ${absolutePath}`);
}
