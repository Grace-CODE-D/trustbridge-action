const ASSET_CODE_REGEX = /^[A-Z0-9]{1,12}$/;
const STELLAR_ISSUER_G_REGEX = /^G[A-Z2-7]{55}$/;
const STELLAR_ISSUER_C_REGEX = /^C[A-Z2-7]{55}$/;

export interface AssetConfigInput {
  assetCode: string;
  assetIssuer: string;
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
