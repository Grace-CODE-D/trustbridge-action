import {
  assertValidAssetCode,
  assertValidAssetIssuer,
  normalizeAssetCode,
  normalizeAssetConfig,
} from '../src/assets';

describe('asset config helpers', () => {
  it('normalizes asset code casing and whitespace', () => {
    expect(normalizeAssetCode(' usdc ')).toBe('USDC');
  });

  it('rejects unsupported asset code formats', () => {
    expect(() => assertValidAssetCode('this-code-is-too-long')).toThrow(/asset_code/);
  });

  it('normalizes full asset config', () => {
    const validIssuer = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    expect(normalizeAssetConfig({ assetCode: ' eurc ', assetIssuer: ` ${validIssuer} ` })).toEqual({
      assetCode: 'EURC',
      assetIssuer: validIssuer,
    });
  });
});

describe('assertValidAssetIssuer', () => {
  it('accepts valid 56-character G-address', () => {
    expect(() => assertValidAssetIssuer('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).not.toThrow();
  });

  it('accepts valid 56-character C-address (Soroban contract)', () => {
    expect(() => assertValidAssetIssuer('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGI')).not.toThrow();
  });

  it('rejects invalid prefixes', () => {
    expect(() => assertValidAssetIssuer('HAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).toThrow(/asset_issuer must be a valid 56-character Stellar public key/);
  });

  it('rejects invalid lengths', () => {
    expect(() => assertValidAssetIssuer('GABC')).toThrow(/asset_issuer must be a valid 56-character Stellar public key/);
  });

  it('rejects invalid base32 characters', () => {
    expect(() => assertValidAssetIssuer('G' + '0'.repeat(55))).toThrow(/asset_issuer must be a valid 56-character Stellar public key/);
  });

  it('rejects empty values', () => {
    expect(() => assertValidAssetIssuer('   ')).toThrow(/asset_issuer must be a valid 56-character Stellar public key/);
  });
});
