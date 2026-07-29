/**
 * Stellar Laboratory and wallet deep-link helpers.
 *
 * ## SEP-0007 wallet deep links
 *
 * SEP-0007 defines a URI scheme (`web+stellar:`) that allows web pages and
 * CI workflows to deep-link into compatible wallets (LOBSTR, Solar, Albedo,
 * etc.) with a pre-built transaction or operation payload.
 *
 * TrustBridge uses SEP-0007 `tx` URIs so that contributors can open a
 * one-click "add trustline" link directly from the issue comment, without
 * having to manually construct a Change Trust operation in Stellar Lab.
 *
 * Reference: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 *
 * ## FAQ anchor deep links (Issue #104)
 *
 * Each failing check maps to a specific anchor in `docs/FAQ.md` so
 * contributors land on the exact fix rather than a generic docs page.
 * Use `buildFaqLink` to generate a durable link from a check name,
 * or `getFaqAnchorForCheck` to resolve the anchor directly.
 *
 * The base URL defaults to this repository's `docs/FAQ.md` but can be
 * overridden with the `docs_base_url` action input for forks or mirrors.
 * Invalid overrides fall back to the default silently so comment posting
 * is never blocked by a bad URL input.
 */

// ---------------------------------------------------------------------------
// FAQ anchor deep links (Issue #104)
// ---------------------------------------------------------------------------

/**
 * The default base URL for the TrustBridge FAQ document.
 * All anchor fragments are appended to this URL.
 */
export const DEFAULT_FAQ_BASE_URL =
  'https://github.com/Stellar-TrustBridge/trustbridge-action/blob/main/docs/FAQ.md';

/**
 * Stable FAQ anchor names. Each corresponds to a heading in `docs/FAQ.md`
 * with an explicit `{#anchor-name}` fragment.
 *
 * Keep this enum in sync with the headings in `docs/FAQ.md`. The CI test
 * `__tests__/faq-anchors.test.ts` verifies every anchor name resolves to
 * a heading in the doc.
 */
export const FAQ_ANCHORS = {
  ACCOUNT_NOT_FUNDED: 'account-not-funded',
  TRUSTLINE_MISSING: 'trustline-missing',
  XLM_RESERVE_TOO_LOW: 'xlm-reserve-too-low',
  TESTING_ON_TESTNET: 'testing-on-testnet',
  HORIZON_ERROR: 'horizon-error',
  DEBUG_MODE: 'debug-mode',
  WEBHOOK_NOT_RECEIVED: 'webhook-not-received',
} as const;

export type FaqAnchor = (typeof FAQ_ANCHORS)[keyof typeof FAQ_ANCHORS];

/**
 * Map from check label keywords to FAQ anchor names.
 * Matching is case-insensitive on the label.
 */
const CHECK_TO_ANCHOR_MAP: Array<{ keyword: string; anchor: FaqAnchor }> = [
  { keyword: 'funded', anchor: FAQ_ANCHORS.ACCOUNT_NOT_FUNDED },
  { keyword: 'trustline', anchor: FAQ_ANCHORS.TRUSTLINE_MISSING },
  { keyword: 'reserve', anchor: FAQ_ANCHORS.XLM_RESERVE_TOO_LOW },
  { keyword: 'xlm', anchor: FAQ_ANCHORS.XLM_RESERVE_TOO_LOW },
  { keyword: 'horizon', anchor: FAQ_ANCHORS.HORIZON_ERROR },
];

/**
 * Resolve the FAQ anchor most relevant to a check label.
 *
 * Returns `undefined` when no mapping is found so callers can omit the
 * FAQ link gracefully.
 *
 * @param checkLabel  The human-readable check label from the `ValidationResult`.
 */
export function getFaqAnchorForCheck(checkLabel: string): FaqAnchor | undefined {
  const lower = checkLabel.toLowerCase();
  for (const { keyword, anchor } of CHECK_TO_ANCHOR_MAP) {
    if (lower.includes(keyword)) {
      return anchor;
    }
  }
  return undefined;
}

/**
 * Build a full FAQ deep link URL for a given anchor.
 *
 * @param anchor   A value from `FAQ_ANCHORS`.
 * @param baseUrl  Optional override for the FAQ base URL (e.g. a fork's
 *                 mirror). When the value is not a valid HTTPS URL, the
 *                 default base URL is used silently so comment posting is
 *                 never blocked by an invalid override.
 */
export function buildFaqLink(anchor: FaqAnchor, baseUrl?: string): string {
  let base = DEFAULT_FAQ_BASE_URL;
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol === 'https:') {
        base = baseUrl.replace(/\/$/, '');
      }
      // Non-HTTPS or unparseable → fall through to default
    } catch {
      // Invalid URL → fall through to default
    }
  }
  return `${base}#${anchor}`;
}

/**
 * Build a FAQ deep link for a check label, resolving the anchor automatically.
 *
 * Returns `undefined` when no FAQ anchor is mapped for the given label, so
 * callers can skip rendering the link.
 *
 * @param checkLabel  The human-readable check label from the ValidationResult.
 * @param baseUrl     Optional FAQ base URL override.
 */
export function buildFaqLinkForCheck(
  checkLabel: string,
  baseUrl?: string,
): string | undefined {
  const anchor = getFaqAnchorForCheck(checkLabel);
  if (!anchor) return undefined;
  return buildFaqLink(anchor, baseUrl);
}

export type StellarNetwork = 'public' | 'testnet';

export function inferStellarNetwork(horizonUrl: string): StellarNetwork {
  return horizonUrl.toLowerCase().includes('testnet') ? 'testnet' : 'public';
}

/**
 * Known Horizon presets and the network they belong to. Used by cross-network
 * detection to identify which network an address was most recently active on.
 */
export const KNOWN_HORIZON_NETWORKS: Record<string, StellarNetwork> = {
  'https://horizon.stellar.org': 'public',
  'https://horizon-testnet.stellar.org': 'testnet',
};

/**
 * Returns the "opposite" Stellar network (for cross-network mismatch error
 * messages that suggest switching to the correct Horizon URL).
 */
export function oppositeNetwork(network: StellarNetwork): StellarNetwork {
  return network === 'public' ? 'testnet' : 'public';
}

/**
 * Returns the canonical Horizon base URL for a given network.
 * Useful when suggesting "switch to the correct Horizon" in error messages.
 */
export function canonicalHorizonUrl(network: StellarNetwork): string {
  return network === 'public'
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org';
}

export function buildAccountViewerLink(stellarAddress: string, network: StellarNetwork): string {
  const params = new URLSearchParams({ network, account: stellarAddress });
  return `https://laboratory.stellar.org/#account-viewer?${params.toString()}`;
}

export function buildChangeTrustLink(network: StellarNetwork): string {
  const params = new URLSearchParams({ network });
  return `https://laboratory.stellar.org/#txbuilder?${params.toString()}`;
}

export function buildLobstrLink(): string {
  return 'https://lobstr.co/';
}

// ---------------------------------------------------------------------------
// SEP-0007 deep-link helpers
// ---------------------------------------------------------------------------

/**
 * Options for building a SEP-0007 `tx` deep link.
 */
export interface Sep0007TxOptions {
  /**
   * Base64-encoded, signed or unsigned XDR `TransactionEnvelope`.
   * When the transaction is unsigned, compatible wallets will sign it before
   * submitting. Pass an unsigned envelope here so TrustBridge never holds a
   * signing key.
   */
  xdr: string;
  /** Optional callback URL the wallet should POST the signed XDR to. */
  callback?: string;
  /** Optional human-readable description shown in the wallet UI. */
  msg?: string;
  /** `public` or `testnet`. Defaults to `public`. */
  network?: StellarNetwork;
  /**
   * Optional network passphrase override. When omitted, the standard
   * passphrase for `network` is used. Set this for custom/private networks.
   */
  networkPassphrase?: string;
  /** Optional origin domain for wallet validation (SEP-0007 §3.4). */
  originDomain?: string;
}

/**
 * Build a SEP-0007 `tx` deep link.
 *
 * The returned URI (`web+stellar:tx?...`) can be used as an `href` in
 * Markdown or HTML so contributors can open it in a SEP-0007-compatible
 * wallet (LOBSTR, Solar, Albedo, etc.) with the transaction pre-loaded.
 *
 * @example
 * ```ts
 * const uri = buildSep0007TxLink({
 *   xdr: 'AAAAAQ...',          // base64 XDR
 *   msg: 'Add USDC trustline',
 *   network: 'public',
 * });
 * // => "web+stellar:tx?xdr=AAAAAQ...&msg=Add+USDC+trustline&network_passphrase=Public+Global+..."
 * ```
 */
export function buildSep0007TxLink(options: Sep0007TxOptions): string {
  const network = options.network ?? 'public';
  const passphrase =
    options.networkPassphrase ??
    (network === 'testnet'
      ? 'Test SDF Network ; September 2015'
      : 'Public Global Stellar Network ; September 2015');

  const params = new URLSearchParams({ xdr: options.xdr });

  params.set('network_passphrase', passphrase);

  if (options.msg) {
    params.set('msg', options.msg);
  }
  if (options.callback) {
    params.set('callback', options.callback);
  }
  if (options.originDomain) {
    params.set('origin_domain', options.originDomain);
  }

  return `web+stellar:tx?${params.toString()}`;
}

/**
 * Options for building a SEP-0007 `pay` deep link.
 */
export interface Sep0007PayOptions {
  /** Destination Stellar G-address. */
  destination: string;
  /** Optional payment amount (string to avoid floating-point issues). */
  amount?: string;
  /** Optional asset code (omit for native XLM). */
  assetCode?: string;
  /** Optional asset issuer (required when `assetCode` is non-native). */
  assetIssuer?: string;
  /** Optional human-readable memo. */
  memo?: string;
  /** Memo type: `text` | `id` | `hash` | `return`. Defaults to `text`. */
  memoType?: 'text' | 'id' | 'hash' | 'return';
  /** Optional human-readable description shown in the wallet UI. */
  msg?: string;
  /** `public` or `testnet`. Defaults to `public`. */
  network?: StellarNetwork;
  /** Optional network passphrase override. */
  networkPassphrase?: string;
  /** Optional origin domain for wallet validation (SEP-0007 §3.4). */
  originDomain?: string;
}

/**
 * Build a SEP-0007 `pay` deep link.
 *
 * Suitable for linking a contributor to a pre-filled payment screen (e.g.
 * "send 1 XLM to activate your account") inside the TrustBridge issue
 * comment.
 *
 * @example
 * ```ts
 * const uri = buildSep0007PayLink({
 *   destination: 'GABC...XYZ',
 *   amount: '1',
 *   msg: 'Activate Stellar account',
 * });
 * // => "web+stellar:pay?destination=GABC...&amount=1&msg=Activate+..."
 * ```
 */
export function buildSep0007PayLink(options: Sep0007PayOptions): string {
  const network = options.network ?? 'public';
  const passphrase =
    options.networkPassphrase ??
    (network === 'testnet'
      ? 'Test SDF Network ; September 2015'
      : 'Public Global Stellar Network ; September 2015');

  const params = new URLSearchParams({ destination: options.destination });

  params.set('network_passphrase', passphrase);

  if (options.amount) {
    params.set('amount', options.amount);
  }
  if (options.assetCode) {
    params.set('asset_code', options.assetCode);
    if (options.assetIssuer) {
      params.set('asset_issuer', options.assetIssuer);
    }
  }
  if (options.memo) {
    params.set('memo', options.memo);
    params.set('memo_type', options.memoType ?? 'text');
  }
  if (options.msg) {
    params.set('msg', options.msg);
  }
  if (options.originDomain) {
    params.set('origin_domain', options.originDomain);
  }

  return `web+stellar:pay?${params.toString()}`;
}
