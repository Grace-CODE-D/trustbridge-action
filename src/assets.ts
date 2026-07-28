import { HorizonBalanceCredit } from './horizon';

const ASSET_CODE_REGEX = /^[A-Z0-9]{1,12}$/;
const STELLAR_ISSUER_G_REGEX = /^G[A-Z2-7]{55}$/;
const STELLAR_ISSUER_C_REGEX = /^C[A-Z2-7]{55}$/;

export interface AssetConfigInput {
  assetCode: string;
  assetIssuer: string;
}

/** Raw shape accepted in the `assets_json` action input. */
export interface AssetJsonEntry {
  code: string;
  issuer: string;
}

export function normalizeAssetCode(assetCode: string): string {
  return assetCode.trim().toUpperCase();
}

export function assertValidAssetCode(assetCode: string): void {
  const normalized = normalizeAssetCode(assetCode);
  if (!ASSET_CODE_REGEX.test(normalized)) {
    throw new Error(
      `asset_code must be 1-12 uppercase alphanumeric characters. Received: "${assetCode}"`,
    );
  }
}

export function assertValidAssetIssuer(assetIssuer: string): void {
  const trimmed = assetIssuer.trim();
  if (trimmed.startsWith('G') && STELLAR_ISSUER_G_REGEX.test(trimmed)) {
    return;
  }
  if (trimmed.startsWith('C') && STELLAR_ISSUER_C_REGEX.test(trimmed)) {
    return;
  }
  throw new Error(
    `asset_issuer must be a valid 56-character Stellar public key starting with "G" or a contract ID starting with "C". Received: "${assetIssuer}"`
  );
}

export function normalizeAssetConfig(input: AssetConfigInput): AssetConfigInput {
  const assetCode = normalizeAssetCode(input.assetCode);
  assertValidAssetCode(assetCode);
  const assetIssuer = input.assetIssuer.trim();
  assertValidAssetIssuer(assetIssuer);
  return {
    assetCode,
    assetIssuer,
  };
}

/**
 * Parse and validate the `assets_json` action input.
 * Accepts a JSON array of `{code, issuer}` objects.
 * Returns normalized `AssetConfigInput[]`.
 * Throws a descriptive error on any parse or validation failure.
 */
export function parseAssetsJson(raw: string): AssetConfigInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new Error(`assets_json must be a valid JSON array. Parse error: ${raw.slice(0, 80)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('assets_json must be a JSON array of {code, issuer} objects.');
  }

  return parsed.map((entry: unknown, idx: number) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`assets_json[${idx}]: each entry must be an object with "code" and "issuer" fields.`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.code !== 'string' || !e.code.trim()) {
      throw new Error(`assets_json[${idx}]: "code" must be a non-empty string.`);
    }
    if (typeof e.issuer !== 'string' || !e.issuer.trim()) {
      throw new Error(`assets_json[${idx}]: "issuer" must be a non-empty string.`);
    }
    return normalizeAssetConfig({ assetCode: e.code as string, assetIssuer: e.issuer as string });
  });
}

/**
 * Remove duplicate assets (same code + issuer after normalization).
 * Preserves first-occurrence order.
 */
export function dedupeAssets(assets: AssetConfigInput[]): AssetConfigInput[] {
  const seen = new Set<string>();
  return assets.filter((a) => {
    const key = `${a.assetCode}:${a.assetIssuer}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
