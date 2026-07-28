import * as core from '@actions/core';

import * as fs from 'fs';
import * as path from 'path';

import { ValidationResult, CheckConfig, buildValidationGate } from './checks';

export interface ActionOutputs {
  trustline_exists: string;
  xlm_balance: string;
  account_funded: string;
  comment_url: string;
}

export function toActionOutputs(result: ValidationResult, commentUrl?: string): ActionOutputs {
  return {
    trustline_exists: String(result.trustlineExists),
    xlm_balance: result.xlmBalance,
    account_funded: String(result.accountFunded),
    comment_url: commentUrl ?? '',
  };
}

export function setValidationOutputs(result: ValidationResult, commentUrl?: string): void {
  const outputs = toActionOutputs(result, commentUrl);
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
