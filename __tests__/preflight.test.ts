/**
 * #145 — issues:write preflight tests
 *
 * Validates that:
 *   - Non-issue events return skip=true with an informational message.
 *   - 401 responses throw PreflightError with clear token guidance.
 *   - 403 responses throw PreflightError with permissions block guidance.
 *   - 404 responses throw PreflightError identifying the missing issue.
 *   - 5xx responses throw PreflightError (fail fast).
 *   - 200 responses return skip=false with the issue number.
 *   - PreflightError distinguishes missing permissions from non-issue context.
 */

import { runIssuesPreflight, PreflightError } from '../src/preflight';

// ---------------------------------------------------------------------------
// Mock @actions/github
// ---------------------------------------------------------------------------

const mockListComments = jest.fn();

jest.mock('@actions/github', () => ({
  context: {
    payload: {},
    repo: { owner: 'test-owner', repo: 'test-repo' },
  },
  getOctokit: jest.fn(() => ({
    rest: {
      issues: {
        listComments: mockListComments,
      },
    },
  })),
}));

// Helper to set github.context.payload.issue
import * as github from '@actions/github';

function setIssueContext(issueNumber: number | undefined) {
   
  (github.context as any).payload = issueNumber !== undefined ? { issue: { number: issueNumber } } : {};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runIssuesPreflight — no issue context', () => {
  beforeEach(() => setIssueContext(undefined));

  it('returns skip=true when there is no issue in the event payload', async () => {
    const result = await runIssuesPreflight('fake-token');
    expect(result.skip).toBe(true);
    expect(result.message).toMatch(/no issue context/i);
  });

  it('does not call the GitHub API when there is no issue context', async () => {
    await runIssuesPreflight('fake-token');
    expect(mockListComments).not.toHaveBeenCalled();
  });
});

describe('runIssuesPreflight — permission checks', () => {
  beforeEach(() => {
    setIssueContext(42);
    mockListComments.mockReset();
  });

  it('returns skip=false with issueNumber when listComments succeeds (200)', async () => {
    mockListComments.mockResolvedValueOnce({ data: [] });
    const result = await runIssuesPreflight('valid-token');
    expect(result.skip).toBe(false);
    expect(result.issueNumber).toBe(42);
    expect(result.message).toContain('#42');
  });

  it('throws PreflightError with 403 guidance when the token lacks issues:write', async () => {
    mockListComments.mockRejectedValue({ status: 403, message: 'Forbidden' });
    await expect(runIssuesPreflight('bad-token')).rejects.toMatchObject({
      name: 'PreflightError',
      statusCode: 403,
      message: expect.stringContaining('issues: write'),
    });
  });

  it('throws PreflightError with 401 guidance for an invalid/expired token', async () => {
    mockListComments.mockRejectedValue({ status: 401, message: 'Unauthorized' });
    await expect(runIssuesPreflight('expired-token')).rejects.toMatchObject({
      name: 'PreflightError',
      statusCode: 401,
      message: expect.stringContaining('not authorized'),
    });
  });

  it('throws PreflightError with 404 guidance when the issue does not exist', async () => {
    mockListComments.mockRejectedValue({ status: 404, message: 'Not Found' });
    await expect(runIssuesPreflight('token')).rejects.toMatchObject({
      name: 'PreflightError',
      statusCode: 404,
      message: expect.stringContaining('#42'),
    });
  });

  it('throws PreflightError for unexpected 5xx errors (fail fast)', async () => {
    mockListComments.mockRejectedValue({ status: 503, message: 'Service Unavailable' });
    await expect(runIssuesPreflight('token')).rejects.toMatchObject({
      name: 'PreflightError',
      statusCode: 503,
    });
  });

  it('distinguishes missing-permissions (403) from non-issue context (skip=true)', async () => {
    // Non-issue context → skip=true, no throw
    setIssueContext(undefined);
    const skipResult = await runIssuesPreflight('token');
    expect(skipResult.skip).toBe(true);

    // Issue context + 403 → PreflightError
    setIssueContext(42);
    mockListComments.mockRejectedValue({ status: 403 });
    await expect(runIssuesPreflight('token')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('PreflightError', () => {
  it('has the correct name and statusCode', () => {
    const err = new PreflightError('bad', 403);
    expect(err.name).toBe('PreflightError');
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe('bad');
    expect(err instanceof Error).toBe(true);
  });
});
