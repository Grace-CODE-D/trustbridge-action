import {
  assertValidAssetCode,
  normalizeAssetCode,
  normalizeAssetConfig,
  parseAssetsJson,
  dedupeAssets,
} from '../src/assets';

describe('asset config helpers', () => {
  it('normalizes asset code casing and whitespace', () => {
    expect(normalizeAssetCode(' usdc ')).toBe('USDC');
  });

  it('rejects unsupported asset code formats', () => {
    expect(() => assertValidAssetCode('this-code-is-too-long')).toThrow(/asset_code/);
  });

  it('normalizes full asset config', () => {
    expect(normalizeAssetConfig({ assetCode: ' eurc ', assetIssuer: ' GABC ' })).toEqual({
      assetCode: 'EURC',
      assetIssuer: 'GABC',
    });
  });
});

describe('parseAssetsJson', () => {
  it('parses a valid JSON array of assets', () => {
    const result = parseAssetsJson(
      '[{"code":"USDC","issuer":"GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"}]',
    );
    expect(result).toEqual([
      { assetCode: 'USDC', assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
    ]);
  });

  it('normalizes asset codes to uppercase', () => {
    const result = parseAssetsJson('[{"code":" eurc ","issuer":"GCQTGZQQ5G4PTM2RNQRAXRJJEL5CQ5Z2OY5SUJRE763CPEKE6EJUMCU"}]');
    expect(result[0].assetCode).toBe('EURC');
  });

  it('parses multiple assets', () => {
    const result = parseAssetsJson(
      '[{"code":"USDC","issuer":"GAAA"},{"code":"EURC","issuer":"GBBB"}]',
    );
    expect(result).toHaveLength(2);
    expect(result[0].assetCode).toBe('USDC');
    expect(result[1].assetCode).toBe('EURC');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseAssetsJson('not-json')).toThrow(/valid JSON array/);
  });

  it('throws when input is not an array', () => {
    expect(() => parseAssetsJson('{"code":"USDC","issuer":"GAAA"}')).toThrow(/JSON array/);
  });

  it('throws when an entry is missing code', () => {
    expect(() => parseAssetsJson('[{"issuer":"GAAA"}]')).toThrow(/"code"/);
  });

  it('throws when an entry is missing issuer', () => {
    expect(() => parseAssetsJson('[{"code":"USDC"}]')).toThrow(/"issuer"/);
  });

  it('throws when an entry is not an object', () => {
    expect(() => parseAssetsJson('["USDC"]')).toThrow(/object/);
  });

  it('returns empty array for empty JSON array', () => {
    expect(parseAssetsJson('[]')).toEqual([]);
  });
});

describe('dedupeAssets', () => {
  it('removes duplicate code+issuer pairs', () => {
    const assets = [
      { assetCode: 'USDC', assetIssuer: 'GAAA' },
      { assetCode: 'USDC', assetIssuer: 'GAAA' },
      { assetCode: 'EURC', assetIssuer: 'GBBB' },
    ];
    expect(dedupeAssets(assets)).toEqual([
      { assetCode: 'USDC', assetIssuer: 'GAAA' },
      { assetCode: 'EURC', assetIssuer: 'GBBB' },
    ]);
  });

  it('keeps assets with same code but different issuers', () => {
    const assets = [
      { assetCode: 'USDC', assetIssuer: 'GAAA' },
      { assetCode: 'USDC', assetIssuer: 'GBBB' },
    ];
    expect(dedupeAssets(assets)).toHaveLength(2);
  });

  it('returns empty array unchanged', () => {
    expect(dedupeAssets([])).toEqual([]);
  });
});
