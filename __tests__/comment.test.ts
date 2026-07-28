import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as github from '@actions/github';
import {
  STICKY_COMMENT_MARKER,
  TRUSTBRIDGE_FOOTER,
  COMMENT_SIZE_LIMIT_BYTES,
  COMMENT_TRUNCATION_NOTICE_BYTES,
  findStickyComment,
  formatCommentBody,
  postIssueComment,
  buildTruncatedCommentBody,
  writeFullReport,
} from '../src/comment';
import { ValidationResult } from '../src/checks';

jest.mock('@actions/github', () => ({
  context: {
    payload: {},
    repo: { owner: 'test-owner', repo: 'test-repo' },
  },
  getOctokit: jest.fn(),
}));

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  getInput: jest.fn(),
}));

const validationResult: ValidationResult = {
  valid: false,
  accountFunded: false,
  trustlineExists: false,
  xlmBalance: '0',
  xlmReserveMet: false,
  checks: [
    {
      passed: false,
      label: 'Account funded',
      detail: 'Account was not found.',
    },
  ],
};

const baseConfig = {
  stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  assetCode: 'USDC',
  assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  minXlmReserve: 1.5,
};

describe('TRUSTBRIDGE_FOOTER', () => {
  it('points back to the action repository', () => {
    expect(TRUSTBRIDGE_FOOTER).toContain('trustbridge-action');
  });
});

describe('formatCommentBody golden snapshots', () => {
  it('matches golden snapshot for successful validation result', () => {
    const successResult: ValidationResult = {
      valid: true,
      accountFunded: true,
      trustlineExists: true,
      xlmBalance: '10.5000000',
      xlmReserveMet: true,
      checks: [
        { passed: true, label: 'Account funded', detail: 'Account exists on Horizon.' },
        { passed: true, label: 'USDC trustline', detail: 'Trustline exists with balance 50.0.' },
        { passed: true, label: 'XLM reserve', detail: 'Balance 10.5 XLM >= minimum 1.5 XLM.' },
      ],
    };

    const body = formatCommentBody(successResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });

    expect(body).toMatchSnapshot();
  });

  it('matches golden snapshot for unfunded account failure path', () => {
    const unfundedResult: ValidationResult = {
      valid: false,
      accountFunded: false,
      trustlineExists: false,
      xlmBalance: '0',
      xlmReserveMet: false,
      checks: [
        { passed: false, label: 'Account funded', detail: 'Account was not found on Horizon (404).' },
        { passed: false, label: 'USDC trustline', detail: 'Cannot check trustline without an active account.' },
        { passed: false, label: 'XLM reserve', detail: 'Cannot check XLM reserve without an active account.' },
      ],
      remediation: 'Send at least 1 XLM to activate account GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF.',
    };

    const body = formatCommentBody(unfundedResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });

    expect(body).toMatchSnapshot();
  });

  it('matches golden snapshot for missing trustline failure path', () => {
    const missingTrustlineResult: ValidationResult = {
      valid: false,
      accountFunded: true,
      trustlineExists: false,
      xlmBalance: '5.0000000',
      xlmReserveMet: true,
      checks: [
        { passed: true, label: 'Account funded', detail: 'Account exists on Horizon.' },
        { passed: false, label: 'USDC trustline', detail: 'Account does not hold a trustline for USDC.' },
        { passed: true, label: 'XLM reserve', detail: 'Balance 5.0 XLM >= minimum 1.5 XLM.' },
      ],
      remediation: 'Add a trustline for asset USDC issued by GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN.',
    };

    const body = formatCommentBody(missingTrustlineResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });

    expect(body).toMatchSnapshot();
  });
});

describe('formatCommentBody', () => {
  it('uses public Stellar Laboratory links for public Horizon', () => {
    const body = formatCommentBody(validationResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });

    expect(body).toContain('account-viewer?network=public&account=');
    expect(body).toContain('txbuilder?network=public');
  });

  it('uses testnet Stellar Laboratory links for testnet Horizon', () => {
    const body = formatCommentBody(validationResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon-testnet.stellar.org',
    });

    expect(body).toContain('account-viewer?network=testnet&account=');
    expect(body).toContain('txbuilder?network=testnet');
  });

  it('embeds the sticky comment marker', () => {
    const body = formatCommentBody(validationResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });

    expect(body).toContain(STICKY_COMMENT_MARKER);
  });

  it('includes a machine-readable validation gate summary', () => {
    const body = formatCommentBody(validationResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });

    expect(body).toContain('### Validation gate');
    expect(body).toContain('Blocked by: Account funded');
    expect(body).toContain('Passed checks: 0/1');
    expect(body).toContain('Failed checks: 1');
  });
});

function makeOctokit(overrides: Record<string, jest.Mock> = {}) {
  return {
    paginate: jest.fn(),
    rest: {
      issues: {
        listComments: jest.fn(),
        createComment: jest.fn(),
        updateComment: jest.fn(),
      },
    },
    ...overrides,
  };
}


describe('findStickyComment', () => {
  it('returns the id of the comment containing the marker', async () => {
    const octokit = makeOctokit();
    octokit.paginate.mockResolvedValue([
      { id: 1, body: 'unrelated comment' },
      { id: 2, body: `${STICKY_COMMENT_MARKER}\nprevious TrustBridge result` },
    ]);

    const id = await findStickyComment(
      octokit as unknown as Parameters<typeof findStickyComment>[0],
      'owner',
      'repo',
      42,
    );

    expect(id).toBe(2);
    expect(octokit.paginate).toHaveBeenCalledWith(
      octokit.rest.issues.listComments,
      expect.objectContaining({ owner: 'owner', repo: 'repo', issue_number: 42 }),
    );
  });

  it('returns undefined when no comment has the marker', async () => {
    const octokit = makeOctokit();
    octokit.paginate.mockResolvedValue([{ id: 1, body: 'unrelated comment' }]);

    const id = await findStickyComment(
      octokit as unknown as Parameters<typeof findStickyComment>[0],
      'owner',
      'repo',
      42,
    );

    expect(id).toBeUndefined();
  });
});

describe('postIssueComment', () => {
  const mockedGithub = github as unknown as {
    context: { payload: { issue?: { number: number } }; repo: { owner: string; repo: string } };
    getOctokit: jest.Mock;
  };

  beforeEach(() => {
    mockedGithub.context.payload = { issue: { number: 7 } };
  });

  it('returns undefined and warns when there is no issue context', async () => {
    mockedGithub.context.payload = {};
    const octokit = makeOctokit();
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const result = await postIssueComment('token', 'body');

    expect(result).toBeUndefined();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('creates a new comment when sticky and no prior comment exists', async () => {
    const octokit = makeOctokit();
    octokit.paginate.mockResolvedValue([]);
    octokit.rest.issues.createComment.mockResolvedValue({
      data: { html_url: 'https://github.com/o/r/issues/7#issuecomment-1' },
    });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const url = await postIssueComment('token', 'new body', { sticky: true });

    expect(url).toBe('https://github.com/o/r/issues/7#issuecomment-1');
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 7, body: 'new body' }),
    );
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it('updates the existing sticky comment instead of creating a new one', async () => {
    const octokit = makeOctokit();
    octokit.paginate.mockResolvedValue([
      { id: 99, body: `${STICKY_COMMENT_MARKER}\nold result` },
    ]);
    octokit.rest.issues.updateComment.mockResolvedValue({
      data: { html_url: 'https://github.com/o/r/issues/7#issuecomment-99' },
    });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const url = await postIssueComment('token', 'updated body', { sticky: true });

    expect(url).toBe('https://github.com/o/r/issues/7#issuecomment-99');
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 99, body: 'updated body' }),
    );
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('always creates a new comment when sticky is disabled', async () => {
    const octokit = makeOctokit();
    octokit.rest.issues.createComment.mockResolvedValue({
      data: { html_url: 'https://github.com/o/r/issues/7#issuecomment-2' },
    });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const url = await postIssueComment('token', 'body', { sticky: false });

    expect(url).toBe('https://github.com/o/r/issues/7#issuecomment-2');
    expect(octokit.paginate).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalled();
  });

  it('falls back to creating a new comment when the sticky lookup fails', async () => {
    const octokit = makeOctokit();
    octokit.paginate.mockRejectedValue(new Error('API rate limit exceeded'));
    octokit.rest.issues.createComment.mockResolvedValue({
      data: { html_url: 'https://github.com/o/r/issues/7#issuecomment-3' },
    });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const url = await postIssueComment('token', 'body', { sticky: true });

    expect(url).toBe('https://github.com/o/r/issues/7#issuecomment-3');
    expect(octokit.rest.issues.createComment).toHaveBeenCalled();
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Oversize comment truncation
// ---------------------------------------------------------------------------

describe('COMMENT_SIZE_LIMIT_BYTES', () => {
  it('is 65536 (GitHub comment size limit)', () => {
    expect(COMMENT_SIZE_LIMIT_BYTES).toBe(65536);
  });

  it('leaves enough room for the truncation notice', () => {
    expect(COMMENT_SIZE_LIMIT_BYTES).toBeGreaterThan(COMMENT_TRUNCATION_NOTICE_BYTES);
  });
});

describe('buildTruncatedCommentBody', () => {
  const reportPath = 'trustbridge-report.md';

  it('returns a body within COMMENT_SIZE_LIMIT_BYTES when given an oversized input', () => {
    const oversizedBody = 'x'.repeat(COMMENT_SIZE_LIMIT_BYTES + 10000);
    const truncated = buildTruncatedCommentBody(oversizedBody, reportPath);
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(COMMENT_SIZE_LIMIT_BYTES);
  });

  it('includes the truncation notice', () => {
    const oversizedBody = 'A'.repeat(COMMENT_SIZE_LIMIT_BYTES + 1000);
    const truncated = buildTruncatedCommentBody(oversizedBody, reportPath);
    expect(truncated).toContain('⚠️ Report truncated');
    expect(truncated).toContain(reportPath);
  });

  it('includes a link to USAGE.md in the truncation notice', () => {
    const oversizedBody = 'B'.repeat(COMMENT_SIZE_LIMIT_BYTES + 500);
    const truncated = buildTruncatedCommentBody(oversizedBody, reportPath);
    expect(truncated).toContain('USAGE.md');
  });

  it('preserves the TrustBridge footer so the sticky marker is present', () => {
    const oversizedBody = 'C'.repeat(COMMENT_SIZE_LIMIT_BYTES + 500);
    const truncated = buildTruncatedCommentBody(oversizedBody, reportPath);
    expect(truncated).toContain('trustbridge-action');
  });

  it('embeds the custom report path in the notice', () => {
    const oversizedBody = 'D'.repeat(COMMENT_SIZE_LIMIT_BYTES + 500);
    const customPath = 'artifacts/my-report.md';
    const truncated = buildTruncatedCommentBody(oversizedBody, customPath);
    expect(truncated).toContain(customPath);
  });

  it('cuts on a line boundary (no partial lines in truncated content)', () => {
    const line = 'line content here\n';
    const repeated = line.repeat(Math.ceil((COMMENT_SIZE_LIMIT_BYTES + 5000) / line.length));
    const truncated = buildTruncatedCommentBody(repeated, reportPath);
    const noticeSeparator = '---\n> **⚠️ Report truncated**';
    const cutIndex = truncated.indexOf(noticeSeparator);
    if (cutIndex > 0) {
      const before = truncated.slice(0, cutIndex);
      expect(before.endsWith('\n') || before.endsWith('\n\n')).toBe(true);
    }
  });

  it('stays well under the limit for a body exactly at the boundary', () => {
    const exactBody = 'E'.repeat(COMMENT_SIZE_LIMIT_BYTES);
    const truncated = buildTruncatedCommentBody(exactBody, reportPath);
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(COMMENT_SIZE_LIMIT_BYTES);
  });
});

describe('writeFullReport', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes the full body to the specified path and returns the resolved path', () => {
    const outputPath = path.join(tmpDir, 'report.md');
    const body = '# Full Report\n\nThis is the full content.';

    const result = writeFullReport(body, outputPath);

    expect(result).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(body);
  });

  it('creates intermediate directories as needed', () => {
    const nestedPath = path.join(tmpDir, 'nested', 'deep', 'report.md');
    const body = 'nested report content';

    const result = writeFullReport(body, nestedPath);

    expect(result).toBe(nestedPath);
    expect(fs.existsSync(nestedPath)).toBe(true);
  });

  it('returns undefined and warns when the path is not writable', () => {
    const { warning } = jest.requireMock('@actions/core') as { warning: jest.Mock };
    warning.mockClear();

    // Use a path with a null byte to force a write error cross-platform
    const badPath = path.join(tmpDir, '\0invalid');
    const result = writeFullReport('body', badPath);

    expect(result).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to write full validation report'),
    );
  });

  it('preserves the exact byte content of the full body', () => {
    const body = '# Report\n\nUnicode: こんにちは 🌟\n\nEnd.';
    const outputPath = path.join(tmpDir, 'unicode-report.md');

    writeFullReport(body, outputPath);

    const written = fs.readFileSync(outputPath, 'utf8');
    expect(written).toBe(body);
  });
});
