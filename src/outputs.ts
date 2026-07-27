import * as core from '@actions/core';

import { ValidationResult } from './checks';

export interface ActionOutputs {
  // Legacy outputs — kept for backward compatibility
  trustline_exists: string;
  xlm_balance: string;
  account_funded: string;
  comment_url: string;
  // Per-check named outputs (Issue #106)
  check_account_funded: string;
  check_trustline: string;
  check_xlm_reserve: string;
}

export function toActionOutputs(result: ValidationResult, commentUrl?: string): ActionOutputs {
  return {
    // Legacy outputs
    trustline_exists: String(result.trustlineExists),
    xlm_balance: result.xlmBalance,
    account_funded: String(result.accountFunded),
    comment_url: commentUrl ?? '',
    // Per-check named outputs — match ValidationResult fields exactly
    check_account_funded: String(result.accountFunded),
    check_trustline: String(result.trustlineExists),
    check_xlm_reserve: String(result.xlmReserveMet),
  };
}

export function setValidationOutputs(result: ValidationResult, commentUrl?: string): void {
  const outputs = toActionOutputs(result, commentUrl);
  for (const [name, value] of Object.entries(outputs)) {
    core.setOutput(name, value);
  }
}
