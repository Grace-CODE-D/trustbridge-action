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
