import { ValidationResult } from '../src/checks';
import { toActionOutputs } from '../src/outputs';

const result: ValidationResult = {
  valid: true,
  accountFunded: true,
  trustlineExists: true,
  xlmBalance: '5.0000000',
  xlmReserveMet: true,
  checks: [],
};

describe('toActionOutputs', () => {
  it('serializes validation outputs for GitHub Actions', () => {
    expect(toActionOutputs(result)).toEqual({
      trustline_exists: 'true',
      xlm_balance: '5.0000000',
      account_funded: 'true',
      comment_url: '',
      assets_trustline_status: '',
      trustlines_summary: '',
    });
  });

  it('includes a comment URL when provided', () => {
    expect(toActionOutputs(result, 'https://github.com/comment')).toEqual({
      trustline_exists: 'true',
      xlm_balance: '5.0000000',
      account_funded: 'true',
      comment_url: 'https://github.com/comment',
      assets_trustline_status: '',
      trustlines_summary: '',
    });
  });

  it('includes per-asset trustline status when multiAssetResults provided', () => {
    const multiAssetResults = [
      { assetCode: 'USDC', assetIssuer: 'GAAA', trustlineExists: true },
      { assetCode: 'EURC', assetIssuer: 'GBBB', trustlineExists: false },
    ];
    const outputs = toActionOutputs(result, undefined, multiAssetResults);
    expect(outputs.assets_trustline_status).toBe(JSON.stringify(multiAssetResults));
    expect(outputs.trustlines_summary).toBe('false');
  });

  it('sets trustlines_summary to true when all assets have trustlines', () => {
    const multiAssetResults = [
      { assetCode: 'USDC', assetIssuer: 'GAAA', trustlineExists: true },
      { assetCode: 'EURC', assetIssuer: 'GBBB', trustlineExists: true },
    ];
    const outputs = toActionOutputs(result, undefined, multiAssetResults);
    expect(outputs.trustlines_summary).toBe('true');
  });

  it('leaves multi-asset outputs empty when multiAssetResults is empty array', () => {
    const outputs = toActionOutputs(result, undefined, []);
    expect(outputs.assets_trustline_status).toBe('');
    expect(outputs.trustlines_summary).toBe('');
  });
});
