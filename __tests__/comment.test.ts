import * as github from '@actions/github';
import {
  STICKY_COMMENT_MARKER,
  STICKY_COMMENT_MARKER_LEGACY,
  TRUSTBRIDGE_FOOTER,
  findStickyComment,
  formatCommentBody,
  isTrustBridgeComment,
  postIssueComment,
} from '../src/comment';
import { ValidationResult } from '../src/checks';

jest.mock('@actions/github', () => ({
  context: {
    payload: {},
    repo: { owner: 'test-owner', repo: 'test-repo' },
    apiUrl: 'https://api.github.com',
  },
  getOctokit: jest.fn(),
}));

const validationResult: ValidationResult = {
  valid: false,
  accountFunded: false,
  trustlineExists: false,
  xlmBalance: '0',
  xlmReserveMet: false,
  assetBalance: '0',
  assetBalanceMet: false,
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
  it('includes delta section when previous-run delta is provided', () => {
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
      delta: {
        previousTimestamp: '2026-07-01T00:00:00.000Z',
        newlyPassed: ['USDC trustline', 'XLM reserve'],
        newlyFailed: [],
        unchanged: ['Account funded'],
        improved: true,
        regressed: false,
      },
    });

    expect(body).toContain('### Delta vs previous run');
    expect(body).toContain('Newly passed:** USDC trustline, XLM reserve');
    expect(body).toContain('Improvement');
  });

  it('omits delta section on first run when delta is null', () => {
    const body = formatCommentBody(validationResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
      delta: null,
    });
    expect(body).not.toContain('### Delta vs previous run');
  });

  it('matches golden snapshot for successful validation result', () => {
    const successResult: ValidationResult = {
      valid: true,
      accountFunded: true,
      trustlineExists: true,
      xlmBalance: '10.5000000',
      xlmReserveMet: true,
      assetBalance: '50.0',
      assetBalanceMet: true,
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
      assetBalance: '0',
      assetBalanceMet: false,
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
      assetBalance: '0',
      assetBalanceMet: false,
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

  it('includes onboarding checklist by default with unchecked boxes for failures', () => {
    const body = formatCommentBody(validationResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
    });

    expect(body).toContain('### Onboarding checklist');
    expect(body).toContain('- [ ] **Fund account**');
    expect(body).toContain('- [ ] **Add USDC trustline**');
    expect(body).toContain('- [ ] **Verify XLM balance**');
    expect(body).toContain('onboarding_checklist');
  });

  it('omits onboarding checklist when disabled', () => {
    const body = formatCommentBody(validationResult, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
      onboardingChecklist: false,
    });

    expect(body).not.toContain('### Onboarding checklist');
    expect(body).toContain('### Results');
    expect(body).toContain('### Validation gate');
  });

  it('checks onboarding boxes from live ValidationResult state', () => {
    const partial: ValidationResult = {
      valid: false,
      accountFunded: true,
      trustlineExists: false,
      xlmBalance: '5.0000000',
      xlmReserveMet: true,
      checks: [
        { passed: true, label: 'Account funded', detail: 'ok' },
        { passed: false, label: 'USDC trustline', detail: 'missing' },
        { passed: true, label: 'XLM reserve', detail: 'ok' },
      ],
    };

    const body = formatCommentBody(partial, {
      ...baseConfig,
      horizonUrl: 'https://horizon.stellar.org',
      onboardingChecklist: true,
    });

    expect(body).toContain('- [x] **Fund account**');
    expect(body).toContain('- [ ] **Add USDC trustline**');
    expect(body).toContain('- [x] **Verify XLM balance**');
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
    context: {
      payload: { issue?: { number: number } };
      repo: { owner: string; repo: string };
      apiUrl: string;
    };
    getOctokit: jest.Mock;
  };

  beforeEach(() => {
    mockedGithub.context.payload = { issue: { number: 7 } };
    mockedGithub.context.apiUrl = 'https://api.github.com';
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
    expect(mockedGithub.getOctokit).toHaveBeenCalledWith('token', {
      baseUrl: 'https://api.github.com',
    });
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

describe('isTrustBridgeComment', () => {
  it('matches the current versioned marker', () => {
    expect(isTrustBridgeComment(`${STICKY_COMMENT_MARKER}\nsome body`)).toBe(true);
  });

  it('matches the legacy marker for backward compatibility', () => {
    expect(isTrustBridgeComment(`${STICKY_COMMENT_MARKER_LEGACY}\nold body`)).toBe(true);
  });

  it('matches the footer alone', () => {
    expect(isTrustBridgeComment(`some body\n${TRUSTBRIDGE_FOOTER}`)).toBe(true);
  });

  it('returns false for unrelated comments', () => {
    expect(isTrustBridgeComment('just a regular comment')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isTrustBridgeComment(null)).toBe(false);
    expect(isTrustBridgeComment(undefined)).toBe(false);
  });
});

describe('findStickyComment — multiple TrustBridge comments', () => {
  it('returns the id of the last TrustBridge comment when multiple exist', async () => {
    const octokit = makeOctokit();
    octokit.paginate.mockResolvedValue([
      { id: 10, body: `${STICKY_COMMENT_MARKER_LEGACY}\nfirst old comment` },
      { id: 20, body: 'unrelated' },
      { id: 30, body: `${STICKY_COMMENT_MARKER}\nmost recent TrustBridge comment` },
    ]);

    const id = await findStickyComment(
      octokit as unknown as Parameters<typeof findStickyComment>[0],
      'owner',
      'repo',
      42,
    );

    expect(id).toBe(30);
  });

  it('matches a comment that only contains the footer', async () => {
    const octokit = makeOctokit();
    octokit.paginate.mockResolvedValue([
      { id: 5, body: `some body\n${TRUSTBRIDGE_FOOTER}` },
    ]);

    const id = await findStickyComment(
      octokit as unknown as Parameters<typeof findStickyComment>[0],
      'owner',
      'repo',
      1,
    );

    expect(id).toBe(5);
  });
});

describe('postIssueComment — update failure fallback', () => {
  const mockedGithub = github as unknown as {
    context: { payload: { issue?: { number: number } }; repo: { owner: string; repo: string } };
    getOctokit: jest.Mock;
  };

  beforeEach(() => {
    mockedGithub.context.payload = { issue: { number: 7 } };
  });

  it('falls back to creating a new comment when updateComment fails', async () => {
    const octokit = makeOctokit();
    octokit.paginate.mockResolvedValue([
      { id: 55, body: `${STICKY_COMMENT_MARKER}\nold result` },
    ]);
    octokit.rest.issues.updateComment.mockRejectedValue(new Error('Not Found'));
    octokit.rest.issues.createComment.mockResolvedValue({
      data: { html_url: 'https://github.com/o/r/issues/7#issuecomment-new' },
    });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const url = await postIssueComment('token', 'body after update failure', { sticky: true });

    expect(url).toBe('https://github.com/o/r/issues/7#issuecomment-new');
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 55 }),
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 7, body: 'body after update failure' }),
    );
  });

  it('falls back to creating when updateComment fails with a rate-limit error', async () => {
    const octokit = makeOctokit();
    octokit.paginate.mockResolvedValue([
      { id: 77, body: `${STICKY_COMMENT_MARKER}\nold` },
    ]);
    octokit.rest.issues.updateComment.mockRejectedValue(new Error('API rate limit exceeded'));
    octokit.rest.issues.createComment.mockResolvedValue({
      data: { html_url: 'https://github.com/o/r/issues/7#issuecomment-rate' },
    });
    mockedGithub.getOctokit.mockReturnValue(octokit);

    const url = await postIssueComment('token', 'body', { sticky: true });

    expect(url).toBe('https://github.com/o/r/issues/7#issuecomment-rate');
    expect(octokit.rest.issues.createComment).toHaveBeenCalled();
  });
});
