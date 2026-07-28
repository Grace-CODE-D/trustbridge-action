export interface AssetConfigInput {
    assetCode: string;
    assetIssuer: string;
}
/** Raw shape accepted in the `assets_json` action input. */
export interface AssetJsonEntry {
    code: string;
    issuer: string;
}
export declare function normalizeAssetCode(assetCode: string): string;
export declare function assertValidAssetCode(assetCode: string): void;
export declare function assertValidAssetIssuer(assetIssuer: string): void;
export declare function normalizeAssetConfig(input: AssetConfigInput): AssetConfigInput;
/**
 * Parse and validate the `assets_json` action input.
 * Accepts a JSON array of `{code, issuer}` objects.
 * Returns normalized `AssetConfigInput[]`.
 * Throws a descriptive error on any parse or validation failure.
 */
export declare function parseAssetsJson(raw: string): AssetConfigInput[];
/**
 * Remove duplicate assets (same code + issuer after normalization).
 * Preserves first-occurrence order.
 */
export declare function dedupeAssets(assets: AssetConfigInput[]): AssetConfigInput[];
