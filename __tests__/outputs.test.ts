import * as fs from 'fs';
import * as path from 'path';
import { ValidationResult } from '../src/checks';
import { toActionOutputs, writeValidationJson } from '../src/outputs';

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
    });
  });

  it('includes a comment URL when provided', () => {
    expect(toActionOutputs(result, 'https://github.com/comment')).toEqual({
      trustline_exists: 'true',
      xlm_balance: '5.0000000',
      account_funded: 'true',
      comment_url: 'https://github.com/comment',
    });
  });
});

describe('writeValidationJson', () => {
  const testPath = 'test-val.json';
  
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2024-01-01T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    if (fs.existsSync(testPath)) {
      fs.unlinkSync(testPath);
    }
  });

  it('writes a JSON artifact omitting sensitive tokens', () => {
    const config = {
      assetCode: 'USDC',
      assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      minXlmReserve: 1.5,
      stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      horizonUrl: 'https://horizon.stellar.org',
    };

    writeValidationJson(result, config, testPath);

    expect(fs.existsSync(testPath)).toBe(true);

    const writtenContent = fs.readFileSync(testPath, 'utf-8');
    const parsed = JSON.parse(writtenContent);
    expect(parsed.timestamp).toBe('2024-01-01T12:00:00.000Z');
    expect(parsed.address).toBe('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
    expect(parsed.asset.code).toBe('USDC');
    expect(parsed.githubToken).toBeUndefined();
  });
});
