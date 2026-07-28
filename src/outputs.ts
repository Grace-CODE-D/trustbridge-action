import * as core from '@actions/core';

import { ValidationResult } from './checks';

export interface ActionOutputs {
  trustline_exists: string;
  xlm_balance: string;
  account_funded: string;
  comment_url: string;
  full_report_path: string;
}

export function toActionOutputs(
  result: ValidationResult,
  commentUrl?: string,
  fullReportPath?: string,
): ActionOutputs {
  return {
    trustline_exists: String(result.trustlineExists),
    xlm_balance: result.xlmBalance,
    account_funded: String(result.accountFunded),
    comment_url: commentUrl ?? '',
    full_report_path: fullReportPath ?? '',
  };
}

export function setValidationOutputs(
  result: ValidationResult,
  commentUrl?: string,
  fullReportPath?: string,
): void {
  const outputs = toActionOutputs(result, commentUrl, fullReportPath);
  for (const [name, value] of Object.entries(outputs)) {
    core.setOutput(name, value);
  }
}
