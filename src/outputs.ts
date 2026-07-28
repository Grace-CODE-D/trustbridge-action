import * as core from '@actions/core';

import { ValidationResult } from './checks';
import { generateBadgeSnippets } from './badge';

export interface ActionOutputs {
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
    trustline_exists: String(result.trustlineExists),
    xlm_balance: result.xlmBalance,
    account_funded: String(result.accountFunded),
    comment_url: commentUrl ?? '',
    readiness_badge_markdown: badgeSnippets.markdown,
    readiness_badge_url: badgeSnippets.url,
  };
}

export function setValidationOutputs(result: ValidationResult, commentUrl?: string): void {
  const outputs = toActionOutputs(result, commentUrl);
  for (const [name, value] of Object.entries(outputs)) {
    core.setOutput(name, value);
  }
}
