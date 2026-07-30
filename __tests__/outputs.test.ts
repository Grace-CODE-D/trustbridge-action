import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ValidationResult } from '../src/checks';
import { toActionOutputs, setValidationOutputs, writeValidationJson } from '../src/outputs';

const result: ValidationResult = {
  valid: true,
  accountFunded: true,
  trustlineExists: true,
  xlmBalance: '5.0000000',
  xlmReserveMet: true,
  checks: [
    { passed: true, label: 'Account funded', detail: 'Funded' },
    { passed: true, label: 'USDC trustline', detail: 'Trustline exists' },
  ],
  reasonCode: 'SUCCESS',
};

describe('toActionOutputs', () => {
  it('serializes legacy and new audit/timing outputs for GitHub Actions', () => {
    const outputs = toActionOutputs(result, undefined, undefined, {
      horizonUrl: 'https://horizon.stellar.org',
      assetCode: 'USDC',
      assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      timings: {
        input_parse_ms: 10,
        horizon_fetch_ms: 100,
        checks_ms: 5,
        comment_post_ms: 20,
        total_ms: 135,
      },
    });

    expect(outputs).toMatchObject({
      trustline_exists: 'true',
      xlm_balance: '5.0000000',
      account_funded: 'true',
      comment_url: '',
      full_report_path: '',
      ready: 'true',
      horizon_url: 'https://horizon.stellar.org',
      asset_code: 'USDC',
      asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      reason_code: 'SUCCESS',
      timing_input_parse_ms: '10',
      timing_horizon_fetch_ms: '100',
      timing_checks_ms: '5',
      timing_comment_post_ms: '20',
      timing_total_ms: '135',
    });

    expect(JSON.parse(outputs.checks_json)).toEqual([
      { label: 'Account funded', passed: true, detail: 'Funded' },
      { label: 'USDC trustline', passed: true, detail: 'Trustline exists' },
    ]);

    expect(JSON.parse(outputs.timings_json)).toEqual({
      input_parse_ms: 10,
      horizon_fetch_ms: 100,
      checks_ms: 5,
      comment_post_ms: 20,
      total_ms: 135,
    });
  });

  it('includes a comment URL and full_report_path when provided', () => {
    const outputs = toActionOutputs(result, 'https://github.com/comment', '/workspace/trustbridge-report.md');
    expect(outputs).toMatchObject({
      trustline_exists: 'true',
      xlm_balance: '5.0000000',
      account_funded: 'true',
      comment_url: 'https://github.com/comment',
      full_report_path: '/workspace/trustbridge-report.md',
    });
  });

  it('serializes failure reason codes for failing results', () => {
    const failResult: ValidationResult = {
      valid: false,
      accountFunded: false,
      trustlineExists: false,
      xlmBalance: '0',
      xlmReserveMet: false,
      checks: [],
      reasonCode: 'ACCOUNT_NOT_FUNDED',
    };
    const outputs = toActionOutputs(failResult);
    expect(outputs.ready).toBe('false');
    expect(outputs.reason_code).toBe('ACCOUNT_NOT_FUNDED');
  });

  it('outputs contain no secrets or PII tokens', () => {
    const outputs = toActionOutputs(result);
    const combined = JSON.stringify(outputs);
    expect(combined).not.toContain('ghp_');
    expect(combined).not.toContain('github_token');
  });

  it('leaves full_report_path empty when not provided', () => {
    const outputs = toActionOutputs(result, undefined, undefined);
    expect(outputs.full_report_path).toBe('');
  });
});
