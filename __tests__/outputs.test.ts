import { ValidationResult } from '../src/checks';
import { toActionOutputs, writeValidationJson } from '../src/outputs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const result: ValidationResult = {
  valid: true,
  accountFunded: true,
  trustlineExists: true,
  xlmBalance: '5.0000000',
  xlmReserveMet: true,
  checks: [
    { passed: true, label: 'Account funded', detail: 'ok' },
    { passed: true, label: 'USDC trustline', detail: 'ok' },
    { passed: true, label: 'XLM reserve', detail: 'ok' },
  ],
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
  it('snapshots a fixture without secrets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-out-'));
    const outPath = path.join(dir, 'validation.json');
    const artifact = writeValidationJson({
      result,
      stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      assetCode: 'USDC',
      assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      horizonUrl: 'https://horizon.stellar.org',
      outputPath: outPath,
      privacyMode: false,
      workspaceRoot: dir,
    });

    expect(artifact.schemaVersion).toBe('1.0.0');
    expect(artifact.address).toBe('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
    expect(artifact.readiness.ready).toBe(true);
    expect(artifact.checks).toHaveLength(3);
    expect(JSON.stringify(artifact)).not.toMatch(/github_token|Authorization|ghp_/i);
    expect(fs.existsSync(outPath)).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
