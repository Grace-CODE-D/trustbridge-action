import * as fs from 'fs';
import * as path from 'path';
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
    const outputs = toActionOutputs(result);
    expect(outputs).toMatchObject({
      trustline_exists: 'true',
      xlm_balance: '5.0000000',
      account_funded: 'true',
      comment_url: '',
      assets_trustline_status: '',
      trustlines_summary: '',
    });
    expect(outputs).toHaveProperty('readiness_badge_markdown');
    expect(outputs).toHaveProperty('readiness_badge_url');
  });

  it('includes a comment URL when provided', () => {
    const outputs = toActionOutputs(result, 'https://github.com/comment');
    expect(outputs).toMatchObject({
      trustline_exists: 'true',
      xlm_balance: '5.0000000',
      account_funded: 'true',
      comment_url: 'https://github.com/comment',
      assets_trustline_status: '',
      trustlines_summary: '',
    });
    expect(outputs).toHaveProperty('readiness_badge_markdown');
    expect(outputs).toHaveProperty('readiness_badge_url');
  });

  it('generates pass badge for valid results', () => {
    const outputs = toActionOutputs(result);
    expect(outputs.readiness_badge_url).toContain('brightgreen');
    expect(outputs.readiness_badge_url).toContain('Ready');
    expect(outputs.readiness_badge_markdown).toContain('brightgreen');
  });

  it('generates fail badge for invalid results', () => {
    const failResult: ValidationResult = {
      valid: false,
      accountFunded: false,
      trustlineExists: false,
      xlmBalance: '0',
      xlmReserveMet: false,
      checks: [],
    };
    const outputs = toActionOutputs(failResult);
    expect(outputs.readiness_badge_url).toContain('red');
    expect(outputs.readiness_badge_url).toContain('Not%20Ready');
    expect(outputs.readiness_badge_markdown).toContain('red');
  });

  it('badge outputs contain no PII', () => {
    const outputs = toActionOutputs(result);
    const combined = outputs.readiness_badge_markdown + outputs.readiness_badge_url;
    expect(combined).not.toContain('5.0000000');
    expect(combined).not.toContain('USDC');
    expect(combined).not.toContain('github.com/account');
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
