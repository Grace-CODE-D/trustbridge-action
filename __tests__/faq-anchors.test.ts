/**
 * Tests for FAQ anchor deep links (Issue #104).
 * Verifies that:
 *   1. Every anchor in FAQ_ANCHORS exists as a heading in docs/FAQ.md.
 *   2. buildFaqLink generates correct URLs.
 *   3. getFaqAnchorForCheck maps check labels to the right anchors.
 *   4. buildFaqLinkForCheck returns undefined for unknown labels.
 *   5. Invalid base URL overrides fall back to the default silently.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  FAQ_ANCHORS,
  DEFAULT_FAQ_BASE_URL,
  getFaqAnchorForCheck,
  buildFaqLink,
  buildFaqLinkForCheck,
  FaqAnchor,
} from '../src/links';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAQ_PATH = path.resolve(__dirname, '..', 'docs', 'FAQ.md');

/**
 * Extract anchor IDs from Markdown headings with explicit {#anchor-id} syntax.
 * e.g. "## Account not funded {#account-not-funded}" → "account-not-funded"
 */
function extractFaqAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const line of markdown.split('\n')) {
    const match = line.match(/\{#([a-z0-9-]+)\}/);
    if (match) {
      anchors.add(match[1]);
    }
  }
  return anchors;
}

// ---------------------------------------------------------------------------
// Anchor existence tests
// ---------------------------------------------------------------------------

describe('FAQ anchor existence in docs/FAQ.md (Issue #104)', () => {
  let faqContent: string;
  let anchorsInDoc: Set<string>;

  beforeAll(() => {
    faqContent = fs.readFileSync(FAQ_PATH, 'utf8');
    anchorsInDoc = extractFaqAnchors(faqContent);
  });

  it('docs/FAQ.md file exists', () => {
    expect(fs.existsSync(FAQ_PATH)).toBe(true);
  });

  it('docs/FAQ.md has at least 4 anchored headings', () => {
    expect(anchorsInDoc.size).toBeGreaterThanOrEqual(4);
  });

  // Verify every anchor in FAQ_ANCHORS exists in the doc
  for (const [name, anchor] of Object.entries(FAQ_ANCHORS)) {
    it(`FAQ_ANCHORS.${name} (#${anchor}) exists in docs/FAQ.md`, () => {
      expect(anchorsInDoc.has(anchor)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// buildFaqLink
// ---------------------------------------------------------------------------

describe('buildFaqLink', () => {
  it('builds a URL with the default base when no override given', () => {
    const link = buildFaqLink(FAQ_ANCHORS.ACCOUNT_NOT_FUNDED);
    expect(link).toBe(`${DEFAULT_FAQ_BASE_URL}#account-not-funded`);
  });

  it('uses the override base URL when valid HTTPS', () => {
    const link = buildFaqLink(FAQ_ANCHORS.TRUSTLINE_MISSING, 'https://myfork.example.com/docs/FAQ.md');
    expect(link).toBe('https://myfork.example.com/docs/FAQ.md#trustline-missing');
  });

  it('falls back to default when override is not HTTPS', () => {
    const link = buildFaqLink(FAQ_ANCHORS.TRUSTLINE_MISSING, 'http://insecure.example.com/faq');
    expect(link).toContain(DEFAULT_FAQ_BASE_URL);
  });

  it('falls back to default when override is an invalid URL', () => {
    const link = buildFaqLink(FAQ_ANCHORS.XLM_RESERVE_TOO_LOW, 'not a url at all');
    expect(link).toContain(DEFAULT_FAQ_BASE_URL);
  });

  it('strips trailing slash from base URL before appending anchor', () => {
    const link = buildFaqLink(FAQ_ANCHORS.HORIZON_ERROR, 'https://example.com/faq/');
    expect(link).toBe('https://example.com/faq#horizon-error');
  });

  it('returns a URL containing the anchor fragment', () => {
    for (const anchor of Object.values(FAQ_ANCHORS) as FaqAnchor[]) {
      const link = buildFaqLink(anchor);
      expect(link).toContain(`#${anchor}`);
    }
  });
});

// ---------------------------------------------------------------------------
// getFaqAnchorForCheck
// ---------------------------------------------------------------------------

describe('getFaqAnchorForCheck', () => {
  it('maps "Account funded" to account-not-funded', () => {
    expect(getFaqAnchorForCheck('Account funded')).toBe(FAQ_ANCHORS.ACCOUNT_NOT_FUNDED);
  });

  it('maps "USDC trustline" to trustline-missing', () => {
    expect(getFaqAnchorForCheck('USDC trustline')).toBe(FAQ_ANCHORS.TRUSTLINE_MISSING);
  });

  it('maps "XLM reserve" to xlm-reserve-too-low', () => {
    expect(getFaqAnchorForCheck('XLM reserve')).toBe(FAQ_ANCHORS.XLM_RESERVE_TOO_LOW);
  });

  it('maps "XLM balance" to xlm-reserve-too-low', () => {
    expect(getFaqAnchorForCheck('XLM balance')).toBe(FAQ_ANCHORS.XLM_RESERVE_TOO_LOW);
  });

  it('maps "Horizon availability" to horizon-error', () => {
    expect(getFaqAnchorForCheck('Horizon availability')).toBe(FAQ_ANCHORS.HORIZON_ERROR);
  });

  it('is case-insensitive', () => {
    expect(getFaqAnchorForCheck('ACCOUNT FUNDED')).toBe(FAQ_ANCHORS.ACCOUNT_NOT_FUNDED);
    expect(getFaqAnchorForCheck('usdc trustline')).toBe(FAQ_ANCHORS.TRUSTLINE_MISSING);
  });

  it('returns undefined for unknown check labels', () => {
    expect(getFaqAnchorForCheck('Custom plugin check')).toBeUndefined();
    expect(getFaqAnchorForCheck('')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildFaqLinkForCheck
// ---------------------------------------------------------------------------

describe('buildFaqLinkForCheck', () => {
  it('returns a URL for known check labels', () => {
    const link = buildFaqLinkForCheck('Account funded');
    expect(link).toBeDefined();
    expect(link).toContain('account-not-funded');
  });

  it('returns undefined for unknown check labels', () => {
    expect(buildFaqLinkForCheck('Unknown special check')).toBeUndefined();
  });

  it('uses override base URL when provided', () => {
    const link = buildFaqLinkForCheck('USDC trustline', 'https://my.fork/docs/FAQ.md');
    expect(link).toContain('my.fork');
    expect(link).toContain('trustline-missing');
  });

  it('falls back to default when override URL is invalid', () => {
    const link = buildFaqLinkForCheck('XLM reserve', 'not-a-url');
    expect(link).toContain(DEFAULT_FAQ_BASE_URL);
  });
});
