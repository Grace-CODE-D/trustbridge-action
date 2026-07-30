/**
 * Tests for expert-mode diagnostics block (Issue #102).
 */

import {
  buildDiagnosticsBlock,
  buildSafeInputsSnapshot,
  DIAGNOSTICS_OPEN_MARKER,
  DIAGNOSTICS_CLOSE_MARKER,
  DiagnosticsConfig,
  DiagnosticsInputSnapshot,
} from '../src/diagnostics';

const BASE_INPUTS: DiagnosticsInputSnapshot = {
  horizonUrl: 'https://horizon.stellar.org',
  horizonUrlFallback: 'https://horizon-testnet.stellar.org',
  assetCode: 'USDC',
  assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  minXlmReserve: '1.5',
  horizonTimeoutMs: 15000,
  useCache: false,
  allowCrossNetworkFallback: false,
  debugMode: true,
};

// ---------------------------------------------------------------------------
// buildSafeInputsSnapshot
// ---------------------------------------------------------------------------

describe('buildSafeInputsSnapshot', () => {
  it('redacts assetIssuer (G-address)', () => {
    const snap = buildSafeInputsSnapshot(BASE_INPUTS);
    expect(snap.assetIssuer).not.toBe(BASE_INPUTS.assetIssuer);
    expect(snap.assetIssuer).toMatch(/\.\.\./);
  });

  it('redacts secret-classified fields', () => {
    const inputs = { ...BASE_INPUTS, github_token: 'ghp_secret', webhookSecret: 'hunter2' };
    const snap = buildSafeInputsSnapshot(inputs);
    expect(snap.github_token).toBe('***');
    expect(snap.webhookSecret).toBe('***');
  });

  it('redacts field names containing "token"', () => {
    const inputs = { ...BASE_INPUTS, myToken: 'abc123' };
    const snap = buildSafeInputsSnapshot(inputs);
    expect(snap.myToken).toBe('***');
  });

  it('passes through non-sensitive string fields', () => {
    const snap = buildSafeInputsSnapshot(BASE_INPUTS);
    expect(snap.assetCode).toBe('USDC');
  });

  it('passes through numeric fields', () => {
    const snap = buildSafeInputsSnapshot(BASE_INPUTS);
    expect(snap.horizonTimeoutMs).toBe(15000);
  });

  it('passes through boolean fields', () => {
    const snap = buildSafeInputsSnapshot(BASE_INPUTS);
    expect(snap.useCache).toBe(false);
  });

  it('redacts Stellar addresses embedded in horizonUrl path', () => {
    const inputs = {
      ...BASE_INPUTS,
      horizonUrl: 'https://horizon.stellar.org/accounts/GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    };
    const snap = buildSafeInputsSnapshot(inputs);
    expect(snap.horizonUrl as string).not.toContain('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
  });
});

// ---------------------------------------------------------------------------
// buildDiagnosticsBlock
// ---------------------------------------------------------------------------

describe('buildDiagnosticsBlock', () => {
  const baseConfig: DiagnosticsConfig = {
    inputs: BASE_INPUTS,
  };

  it('includes open and close markers', () => {
    const block = buildDiagnosticsBlock(baseConfig);
    expect(block).toContain(DIAGNOSTICS_OPEN_MARKER);
    expect(block).toContain(DIAGNOSTICS_CLOSE_MARKER);
  });

  it('wraps content in a <details> collapsible block', () => {
    const block = buildDiagnosticsBlock(baseConfig);
    expect(block).toContain('<details>');
    expect(block).toContain('</details>');
    expect(block).toContain('<summary>');
    expect(block).toContain('Expert diagnostics');
  });

  it('includes normalized inputs section by default', () => {
    const block = buildDiagnosticsBlock(baseConfig);
    expect(block).toContain('Normalized inputs');
    expect(block).toContain('assetCode');
    expect(block).toContain('USDC');
  });

  it('omits inputs section when showInputs=false', () => {
    const block = buildDiagnosticsBlock({ ...baseConfig, showInputs: false });
    expect(block).not.toContain('Normalized inputs');
  });

  it('includes Horizon request details when runInfo is provided', () => {
    const block = buildDiagnosticsBlock({
      ...baseConfig,
      runInfo: { horizonStatusCode: 200, horizonLatencyMs: 143, retryCount: 0 },
    });
    expect(block).toContain('Horizon request details');
    expect(block).toContain('200');
    expect(block).toContain('143 ms');
  });

  it('shows fallback flag when usedFallback is true', () => {
    const block = buildDiagnosticsBlock({
      ...baseConfig,
      runInfo: { usedFallback: true },
    });
    expect(block).toContain('Used fallback URL');
    expect(block).toContain('true');
  });

  it('shows cache flag when fromCache is true', () => {
    const block = buildDiagnosticsBlock({
      ...baseConfig,
      runInfo: { fromCache: true },
    });
    expect(block).toContain('Served from cache');
  });

  it('redacts the asset issuer in the inputs table', () => {
    const block = buildDiagnosticsBlock(baseConfig);
    // Full address must not appear
    expect(block).not.toContain('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
    expect(block).toContain('GA5Z');
  });

  it('redacts horizon error messages', () => {
    const errorWithAddress =
      'Horizon error for GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN: timeout';
    const block = buildDiagnosticsBlock({
      ...baseConfig,
      runInfo: { horizonError: errorWithAddress },
    });
    expect(block).not.toContain('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
    expect(block).toContain('timeout');
  });

  it('does not include secret fields in the inputs table', () => {
    const inputs = { ...BASE_INPUTS, github_token: 'ghp_secret_value', webhookSecret: 'hunter2' };
    const block = buildDiagnosticsBlock({ inputs });
    expect(block).not.toContain('ghp_secret_value');
    expect(block).not.toContain('hunter2');
    expect(block).toContain('redacted');
  });

  it('includes a note that the section is debug-mode only', () => {
    const block = buildDiagnosticsBlock(baseConfig);
    expect(block).toContain('debug_mode: true');
  });

  it('states no secrets are included', () => {
    const block = buildDiagnosticsBlock(baseConfig);
    expect(block).toContain('No secrets are included');
  });

  it('shows error status code with ❌ badge', () => {
    const block = buildDiagnosticsBlock({
      ...baseConfig,
      runInfo: { horizonStatusCode: 503 },
    });
    expect(block).toContain('❌ 503');
  });

  it('shows success status code with ✅ badge', () => {
    const block = buildDiagnosticsBlock({
      ...baseConfig,
      runInfo: { horizonStatusCode: 200 },
    });
    expect(block).toContain('✅ 200');
  });
});
