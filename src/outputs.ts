import * as core from '@actions/core';

import { AssetTrustlineResult, ValidationResult } from './checks';

export interface ActionOutputs {
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
