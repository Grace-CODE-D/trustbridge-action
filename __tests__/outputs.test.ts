import { ValidationResult } from '../src/checks';
import { toActionOutputs } from '../src/outputs';

const result: ValidationResult = {
  valid: true,
  accountFunded: true,
  trustlineExists: true,
  xlmBalance: '5.0000000',
  xlmReserveMet: true,
  assetBalance: '100.0000000',
  assetBalanceMet: true,
  checks: [],
};

describe('toActionOutputs', () => {
  it('serializes validation outputs for GitHub Actions', () => {
    expect(toActionOutputs(result)).toEqual({
      trustline_exists: 'true',
      xlm_balance: '5.0000000',
      account_funded: 'true',
      comment_url: '',
      asset_balance: '100.0000000',
      asset_balance_met: 'true',
    });
  });

  it('includes a comment URL when provided', () => {
    expect(toActionOutputs(result, 'https://github.com/comment')).toEqual({
      trustline_exists: 'true',
      xlm_balance: '5.0000000',
      account_funded: 'true',
      comment_url: 'https://github.com/comment',
      asset_balance: '100.0000000',
      asset_balance_met: 'true',
    });
  });

  it('serializes asset_balance_met as false when below floor', () => {
    const failingResult: ValidationResult = {
      ...result,
      assetBalance: '10.0000000',
      assetBalanceMet: false,
    };
    expect(toActionOutputs(failingResult).asset_balance_met).toBe('false');
    expect(toActionOutputs(failingResult).asset_balance).toBe('10.0000000');
  });

  it('serializes unknown asset balance when horizon fails', () => {
    const failedResult: ValidationResult = {
      ...result,
      valid: false,
      assetBalance: 'unknown',
      assetBalanceMet: false,
    };
    expect(toActionOutputs(failedResult).asset_balance).toBe('unknown');
    expect(toActionOutputs(failedResult).asset_balance_met).toBe('false');
  });
});
