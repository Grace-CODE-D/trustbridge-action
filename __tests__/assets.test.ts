import {
  assertValidAssetCode,
  getCampaignPreset,
  MAINNET_USDC_ISSUER,
  normalizeAssetCode,
  normalizeAssetConfig,
  TESTNET_USDC_ISSUER,
  validateNetworkAssetCompatibility,
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

  describe('campaign presets & network compatibility', () => {
    it('resolves testnet campaign preset defaults correctly', () => {
      const preset = getCampaignPreset('testnet');
      expect(preset).toBeDefined();
      expect(preset?.network).toBe('testnet');
      expect(preset?.horizonUrl).toBe('https://horizon-testnet.stellar.org');
      expect(preset?.assetIssuer).toBe(TESTNET_USDC_ISSUER);
    });

    it('rejects mainnet issuer on testnet Horizon', () => {
      expect(() =>
        validateNetworkAssetCompatibility(
          'https://horizon-testnet.stellar.org',
          'USDC',
          MAINNET_USDC_ISSUER,
        ),
      ).toThrow(/Incompatible network configuration/);
    });

    it('rejects testnet issuer on public mainnet Horizon', () => {
      expect(() =>
        validateNetworkAssetCompatibility(
          'https://horizon.stellar.org',
          'USDC',
          TESTNET_USDC_ISSUER,
        ),
      ).toThrow(/Incompatible network configuration/);
    });

    it('allows valid testnet preset configuration', () => {
      expect(() =>
        validateNetworkAssetCompatibility(
          'https://horizon-testnet.stellar.org',
          'USDC',
          TESTNET_USDC_ISSUER,
          'testnet',
        ),
      ).not.toThrow();
    });

    it('detects preset conflict when horizon_url mismatches preset network', () => {
      expect(() =>
        validateNetworkAssetCompatibility(
          'https://horizon.stellar.org',
          'USDC',
          TESTNET_USDC_ISSUER,
          'testnet',
        ),
      ).toThrow(/Preset conflict|Incompatible network/);
    });
  });
});
