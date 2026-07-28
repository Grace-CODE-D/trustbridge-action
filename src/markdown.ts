import { ValidationResult } from './checks';

export function escapeMarkdownInline(value: string): string {
  return value.replace(/([`*_{}[\]()#+.!|>~-])/g, '\\$1');
}

export function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, '\\`')}\``;
}

/** Base URL for FAQ anchors linked from the onboarding checklist. */
export const TROUBLESHOOTING_FAQ_BASE =
  'https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/TROUBLESHOOTING.md';

export interface OnboardingChecklistOptions {
  /** Asset code shown in the trustline checklist item (already escaped for Markdown). */
  assetCode: string;
  /** Minimum XLM reserve shown in the balance checklist item. */
  minXlmReserve: number;
}

/**
 * Render a GitHub Markdown task-list checklist whose boxes reflect live
 * `ValidationResult` state (fund → trustline → verify balance).
 *
 * Checkboxes are comment-only (no GitHub Projects task-list API sync).
 */
export function buildOnboardingChecklist(
  result: ValidationResult,
  options: OnboardingChecklistOptions,
): string {
  const safeAsset = escapeMarkdownInline(options.assetCode);
  const fundFaq = `${TROUBLESHOOTING_FAQ_BASE}#account-is-reported-unfunded`;
  const trustFaq = `${TROUBLESHOOTING_FAQ_BASE}#trustline-is-missing`;
  const reserveFaq = `${TROUBLESHOOTING_FAQ_BASE}#xlm-reserve-too-low`;

  const lines = [
    '### Onboarding checklist',
    '',
    '_Complete these steps in order. Boxes update automatically from live Horizon checks._',
    '',
    `- [${result.accountFunded ? 'x' : ' '}] **Fund account** — Activate the account with XLM. ([FAQ](${fundFaq}))`,
    `- [${result.trustlineExists ? 'x' : ' '}] **Add ${safeAsset} trustline** — Configure the asset trustline. ([FAQ](${trustFaq}))`,
    `- [${result.xlmReserveMet ? 'x' : ' '}] **Verify XLM balance** — Meet the **${options.minXlmReserve} XLM** reserve. ([FAQ](${reserveFaq}))`,
  ];

  return lines.join('\n');
}
