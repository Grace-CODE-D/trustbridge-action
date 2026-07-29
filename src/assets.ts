const ASSET_CODE_REGEX = /^[A-Z0-9]{1,12}$/;

export const MAINNET_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
export const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK2P7MDEVSCWR7DPUWV3NY3DTQEVFL4TWVC5GIOTASHEX2';

export interface CampaignPreset {
  id: string;
  network: 'public' | 'testnet';
  horizonUrl: string;
  assetCode: string;
  assetIssuer: string;
  minXlmReserve: string;
}

export const CAMPAIGN_PRESETS: Record<string, CampaignPreset> = {
  testnet: {
    id: 'testnet',
    network: 'testnet',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    assetCode: 'USDC',
    assetIssuer: TESTNET_USDC_ISSUER,
    minXlmReserve: '1.5',
  },
  'testnet-usdc': {
    id: 'testnet-usdc',
    network: 'testnet',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    assetCode: 'USDC',
    assetIssuer: TESTNET_USDC_ISSUER,
    minXlmReserve: '1.5',
  },
  public: {
    id: 'public',
    network: 'public',
    horizonUrl: 'https://horizon.stellar.org',
    assetCode: 'USDC',
    assetIssuer: MAINNET_USDC_ISSUER,
    minXlmReserve: '1.5',
  },
  mainnet: {
    id: 'mainnet',
    network: 'public',
    horizonUrl: 'https://horizon.stellar.org',
    assetCode: 'USDC',
    assetIssuer: MAINNET_USDC_ISSUER,
    minXlmReserve: '1.5',
  },
};

export function getCampaignPreset(presetOrNetworkName?: string): CampaignPreset | undefined {
  if (!presetOrNetworkName) return undefined;
  const key = presetOrNetworkName.trim().toLowerCase();
  return CAMPAIGN_PRESETS[key];
}

export function validateNetworkAssetCompatibility(
  horizonUrl: string,
  assetCode: string,
  assetIssuer: string,
  presetName?: string,
): void {
  const isTestnetHorizon = horizonUrl.toLowerCase().includes('testnet');
  const normalizedIssuer = assetIssuer.trim();
  const normalizedCode = assetCode.trim().toUpperCase();

  if (isTestnetHorizon && normalizedIssuer === MAINNET_USDC_ISSUER) {
    throw new Error(
      `Incompatible network configuration: Mainnet ${normalizedCode} issuer (${MAINNET_USDC_ISSUER}) cannot be used on Stellar Testnet (${horizonUrl}). Use testnet issuer ${TESTNET_USDC_ISSUER} or switch to public Horizon.`,
    );
  }

  if (!isTestnetHorizon && normalizedIssuer === TESTNET_USDC_ISSUER) {
    throw new Error(
      `Incompatible network configuration: Testnet ${normalizedCode} issuer (${TESTNET_USDC_ISSUER}) cannot be used on Stellar Mainnet (${horizonUrl}). Use mainnet issuer ${MAINNET_USDC_ISSUER} or switch to testnet Horizon.`,
    );
  }

  if (presetName) {
    const preset = getCampaignPreset(presetName);
    if (preset) {
      if (preset.network === 'testnet' && !isTestnetHorizon) {
        throw new Error(
          `Preset conflict: Preset "${presetName}" specifies testnet, but horizon_url is set to non-testnet URL "${horizonUrl}".`,
        );
      }
      if (preset.network === 'public' && isTestnetHorizon) {
        throw new Error(
          `Preset conflict: Preset "${presetName}" specifies public mainnet, but horizon_url is set to testnet URL "${horizonUrl}".`,
        );
      }
    }
  }
}

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

export function normalizeAssetConfig(input: AssetConfigInput): AssetConfigInput {
  const assetCode = normalizeAssetCode(input.assetCode);
  assertValidAssetCode(assetCode);
  return {
    assetCode,
    assetIssuer: input.assetIssuer.trim(),
  };
}
