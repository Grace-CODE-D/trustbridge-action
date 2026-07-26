import { HorizonError, isCreditBalance,
  isRetryableStatus,
  parseRetryAfterMs,
  parseHorizonBalance, normalizeHorizonUrl } from '../src/horizon';
import { fetchAccount, HorizonAccount, waitForFundedAccount, getNativeBalance, hasTrustline } from '../src/horizon';
import * as loggerModule from '../src/logger';
import { SimpleCache } from '../src/cache';
import type { Request, RequestInit, Response } from 'node-fetch';

const TEST_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const TEST_ADDRESS_2 = `G${'B'.repeat(52)}WHF`;
const FALLBACK_ADDRESS = `G${'C'.repeat(52)}WHF`;
const PRIMARY_HORIZON = 'https://horizon.stellar.org';
const FALLBACK_HORIZON = 'https://horizon-fallback.stellar.org';

function makeAccount(address: string = TEST_ADDRESS): HorizonAccount {
  return {
    id: address,
    account_id: address,
    sequence: '1',
    subentry_count: 2,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        balance: '10.0000000',
        asset_type: 'native',
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
      {
        balance: '5.0000000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: TEST_ADDRESS_2,
        buying_liabilities: '0.0000000',
        selling_liabilities: '0.0000000',
      },
    ],
  };
}

type DebugCall = { message: string; context: loggerModule.LogContext | undefined };
type TestContext = loggerModule.LogContext & Record<string, unknown>;
type FetchArg = string | Request;

function captureDebugCalls(): { calls: DebugCall[]; restore: () => void } {
  const calls: DebugCall[] = [];
  const spy = jest
    .spyOn(loggerModule.logger, 'debug')
    .mockImplementation((message, context) => {
      const safeMessage = loggerModule.redactString(message);
      const safeContext = loggerModule.redactContext(context);
      calls.push({
        message: safeMessage,
        context: safeContext ? { ...safeContext } : undefined,
      });
    });
  return {
    calls,
    restore: () => spy.mockRestore(),
  };
}

function assertNoRawAddress(text: string | undefined, raw: string): void {
  if (!text) return;
  expect(text).not.toContain(raw);
}

function assertContextHasNoRawAddress(
  context: loggerModule.LogContext | undefined,
  rawAddress: string,
): void {
  if (!context) return;
  for (const [, value] of Object.entries(context)) {
    if (typeof value === 'string') {
      assertNoRawAddress(value, rawAddress);
    } else if (typeof value === 'object' && value !== null) {
      const json = JSON.stringify(value);
      assertNoRawAddress(json, rawAddress);
    }
  }
}

function assertAllCallsRedacted(
  calls: DebugCall[],
  rawAddresses: string[],
): void {
  for (const call of calls) {
    for (const addr of rawAddresses) {
      assertNoRawAddress(call.message, addr);
      assertContextHasNoRawAddress(call.context, addr);
    }
  }
}

function redactForAddress(raw: string): string {
  return loggerModule.redactStellarAddress(raw);
}

function requireContext(call: DebugCall | undefined): TestContext {
  expect(call).toBeDefined();
  return (call?.context ?? {}) as TestContext;
}

type MockFetch = jest.Mock<Promise<Response>, [FetchArg, RequestInit?]>;

function makeMockFetch(
  impl: (url: FetchArg, init?: RequestInit) => Promise<Response>,
): MockFetch {
  return jest.fn<Promise<Response>, [FetchArg, RequestInit?]>(impl);
}

function makeMockResponse(
  status: number,
  body: unknown,
  opts?: { headers?: Record<string, string> },
): Response {
  const headersMap: Record<string, string> = opts?.headers ?? {};
  const headers = new (class {
    private h: Record<string, string>;
    constructor(h: Record<string, string>) { this.h = h; }
    get(k: string) { return this.h[k.toLowerCase()] ?? null; }
  })(headersMap);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Error',
    headers,
    json: async () => body,
  } as unknown as Response;
}

describe('normalizeHorizonUrl', () => {
  it('trims whitespace and trailing slashes', () => {
    expect(normalizeHorizonUrl(' https://horizon.stellar.org/// ')).toBe(
      'https://horizon.stellar.org',
    );
  });

  it('returns an empty string for blank values', () => {
    expect(normalizeHorizonUrl('   ')).toBe('');
  });
});

describe('parseRetryAfterMs', () => {
  it('parses seconds-based retry headers', () => {
    const response = { headers: { get: () => '2' } } as unknown as import('node-fetch').Response;
    expect(parseRetryAfterMs(response)).toBe(2000);
  });
});

describe('isRetryableStatus', () => {
  it('flags transient Horizon statuses', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
  });
});

describe('isCreditBalance', () => {
  it('detects credit balances', () => {
    expect(isCreditBalance({ balance: '1', asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', buying_liabilities: '0', selling_liabilities: '0' })).toBe(true);
    expect(isCreditBalance({ balance: '1', asset_type: 'native', buying_liabilities: '0', selling_liabilities: '0' })).toBe(false);
  });
});

describe('parseHorizonBalance', () => {
  it('parses numeric balances and falls back to zero', () => {
    expect(parseHorizonBalance('1.5000000')).toBe(1.5);
    expect(parseHorizonBalance('bad')).toBe(0);
  });
});

describe('getNativeBalance & hasTrustline', () => {
  it('extracts native XLM balance correctly', () => {
    const account = makeAccount();
    expect(getNativeBalance(account)).toBe('10.0000000');
  });

  it('returns 0 when native balance is missing', () => {
    const account = makeAccount();
    account.balances = [];
    expect(getNativeBalance(account)).toBe('0');
  });

  it('checks if trustline exists for code and issuer', () => {
    const account = makeAccount();
    expect(hasTrustline(account, 'USDC', TEST_ADDRESS_2)).toBe(true);
    expect(hasTrustline(account, 'EURT', TEST_ADDRESS_2)).toBe(false);
  });
});

describe('fetchAccount: basic', () => {
  it('fails fast when horizon_url is blank', async () => {
    await expect(fetchAccount('   ', TEST_ADDRESS)).rejects.toMatchObject({
      message: 'horizon_url is required.',
      statusCode: 0,
      retryable: false,
    } satisfies Partial<HorizonError>);
  });
});

describe('waitForFundedAccount', () => {
  it('returns the account once a poll succeeds', async () => {
    const account = makeAccount();
    const fetchAccountFn = jest
      .fn()
      .mockRejectedValueOnce(new HorizonError('not found', 404, false))
      .mockRejectedValueOnce(new HorizonError('not found', 404, false))
      .mockResolvedValueOnce(account);

    const onPoll = jest.fn();

    const result = await waitForFundedAccount(
      PRIMARY_HORIZON,
      TEST_ADDRESS,
      { timeoutMs: 5000, pollIntervalMs: 5, onPoll },
      fetchAccountFn,
    );

    expect(result).toBe(account);
    expect(fetchAccountFn).toHaveBeenCalledTimes(3);
    expect(onPoll).toHaveBeenCalledTimes(2);
  });

  it('throws a 404 HorizonError once the timeout budget is exhausted', async () => {
    const fetchAccountFn = jest.fn().mockRejectedValue(new HorizonError('not found', 404, false));

    await expect(
      waitForFundedAccount(
        PRIMARY_HORIZON,
        TEST_ADDRESS,
        { timeoutMs: 20, pollIntervalMs: 5 },
        fetchAccountFn,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rethrows non-404 errors immediately without polling further', async () => {
    const outage = new HorizonError('Horizon request failed (503): maintenance', 503, true);
    const fetchAccountFn = jest.fn().mockRejectedValue(outage);

    await expect(
      waitForFundedAccount(
        PRIMARY_HORIZON,
        TEST_ADDRESS,
        { timeoutMs: 5000, pollIntervalMs: 5 },
        fetchAccountFn,
      ),
    ).rejects.toBe(outage);
    expect(fetchAccountFn).toHaveBeenCalledTimes(1);
  });
});

describe('Horizon debug log redaction', () => {
  const RAW_ADDRESSES = [TEST_ADDRESS, TEST_ADDRESS_2, FALLBACK_ADDRESS];

  describe('fetch path: success debug logs redact addresses and URLs', () => {
    it('redacts stellar addresses and horizon URLs from every debug line on success', async () => {
      const { calls, restore } = captureDebugCalls();
      const account = makeAccount(TEST_ADDRESS);
      const mock = makeMockFetch(async () => makeMockResponse(200, account));
      loggerModule.logger.setDebugMode(true);
      const expectedRedacted = redactForAddress(TEST_ADDRESS);

      try {
        const result = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 0,
          fetchFn: mock,
        });
        expect(result.account_id).toBe(TEST_ADDRESS);
        expect(mock).toHaveBeenCalledTimes(1);
        expect(calls.length).toBeGreaterThan(0);
        const fetchStart = calls.find((c) => c.message === 'Horizon fetch start');
        expect(fetchStart).toBeDefined();
        expect(fetchStart!.context?.url).toContain(expectedRedacted);
        const success = calls.find((c) => c.message === 'Horizon fetch success');
        const successCtx = requireContext(success);
        expect(successCtx.balancesCount).toBe(2);
        expect(successCtx.creditTrustlineCount).toBe(1);
        expect(successCtx.subentryCount).toBe(2);
        expect(successCtx.balances).toBeUndefined();
        expect(successCtx.sequence).toBeUndefined();
        expect(successCtx.account_id).toBeUndefined();
        assertAllCallsRedacted(calls, RAW_ADDRESSES);
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });

    it('redacts addresses in error debug lines (400 non-retryable parses body)', async () => {
      const { calls, restore } = captureDebugCalls();
      const errBody = { type: 'https://stellar.org/horizon-errors/bad_request', title: 'Bad Request', status: 400, detail: `The resource at /accounts/${TEST_ADDRESS} was malformed` };
      const mock = makeMockFetch(async () => makeMockResponse(400, errBody));
      loggerModule.logger.setDebugMode(true);
      const expectedRedacted = redactForAddress(TEST_ADDRESS);

      try {
        await expect(fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 0,
          fetchFn: mock,
        })).rejects.toMatchObject({ statusCode: 400 });
        expect(mock).toHaveBeenCalledTimes(1);
        expect(calls.length).toBeGreaterThan(0);
        const parsed = calls.find((c) => c.message === 'Horizon error response parsed');
        const parsedCtx = requireContext(parsed);
        expect(parsedCtx.errorDetail).toContain(expectedRedacted);
        assertAllCallsRedacted(calls, RAW_ADDRESSES);
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });

    it('emits 404-specific debug line and does not try fallback for 404', async () => {
      const { calls, restore } = captureDebugCalls();
      const errBody = { type: 'https://stellar.org/horizon-errors/not_found', title: 'Not Found', status: 404, detail: `Not found` };
      const mock = makeMockFetch(async () => makeMockResponse(404, errBody));
      loggerModule.logger.setDebugMode(true);

      try {
        await expect(fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 0,
          horizonUrlFallback: FALLBACK_HORIZON,
          fetchFn: mock,
        })).rejects.toMatchObject({ statusCode: 404 });
        expect(mock).toHaveBeenCalledTimes(1);
        const notFound = calls.find((c) => c.message === 'Horizon account not found (404)');
        expect(notFound).toBeDefined();
        const fallbackSwitch = calls.find((c) =>
          c.message === 'Horizon RPC fallback: primary exhausted, switching to fallback URL',
        );
        expect(fallbackSwitch).toBeUndefined();
        assertAllCallsRedacted(calls, RAW_ADDRESSES);
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });
  });

  describe('retry path: transient HTTP 429 + retry debug logs redacted', () => {
    it('redacts addresses and retry details on transient HTTP retries', async () => {
      const { calls, restore } = captureDebugCalls();
      const account = makeAccount(TEST_ADDRESS);
      const errBody = { type: 'rate_limit', title: 'Too Many Requests', status: 429, detail: `Account ${TEST_ADDRESS} exceeded rate limit` };
      let callCount = 0;
      const mock = makeMockFetch(async () => {
        callCount += 1;
        if (callCount < 2) {
          return makeMockResponse(429, errBody, { headers: { 'retry-after': '0' } });
        }
        return makeMockResponse(200, account);
      });
      const origSetTimeout = global.setTimeout;
      global.setTimeout = ((callback: Parameters<typeof setTimeout>[0]) =>
        origSetTimeout(callback, 0)) as typeof setTimeout;
      loggerModule.logger.setDebugMode(true);
      const expectedRedacted = redactForAddress(TEST_ADDRESS);

      try {
        const result = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 2,
          cacheTtlMs: 0,
          fetchFn: mock,
        });
        expect(result.account_id).toBe(TEST_ADDRESS);
        expect(mock).toHaveBeenCalledTimes(2);
        const retrySched = calls.find((c) => c.message === 'Horizon retry scheduled');
        const retryCtx = requireContext(retrySched);
        expect(retryCtx.nextAttempt).toBe(1);
        expect(retryCtx.retryAfterFromHeader).toBe(true);
        const parsedErr = calls.find((c) => c.message === 'Horizon error response parsed');
        const parsedErrCtx = requireContext(parsedErr);
        expect(parsedErrCtx.errorDetail).not.toContain(TEST_ADDRESS);
        expect(parsedErrCtx.errorDetail).toContain(expectedRedacted);
        assertAllCallsRedacted(calls, RAW_ADDRESSES);
      } finally {
        global.setTimeout = origSetTimeout;
        jest.restoreAllMocks();
        restore();
      }
    });
  });

  describe('cache path: cache lookup, hit, miss, and populate debug logs redacted', () => {
    it('redacts cache keys and embedded addresses on cache hit and populate', async () => {
      const { calls, restore } = captureDebugCalls();
      const cache = new SimpleCache();
      const account = makeAccount(TEST_ADDRESS);
      const mock = makeMockFetch(async () => makeMockResponse(200, account));
      loggerModule.logger.setDebugMode(true);
      const expectedRedacted = redactForAddress(TEST_ADDRESS);

      try {
        const first = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 60_000,
          cache,
          fetchFn: mock,
        });
        expect(first.account_id).toBe(TEST_ADDRESS);
        expect(mock).toHaveBeenCalledTimes(1);
        const lookup = calls.find((c) => c.message === 'Horizon cache lookup start');
        const lookupCtx = requireContext(lookup);
        expect(lookupCtx.cacheKey).toContain('horizon:account:');
        expect(lookupCtx.cacheKey).not.toContain(TEST_ADDRESS);
        expect(lookupCtx.cacheKey).toContain(expectedRedacted);
        const miss = calls.find((c) => c.message === 'Horizon cache miss');
        expect(miss).toBeDefined();
        const populate = calls.find((c) => c.message === 'Horizon cache populate after primary success');
        const populateCtx = requireContext(populate);
        expect(populateCtx.source).toBe('primary');
        expect(populateCtx.cacheSizeAfter).toBe(1);
        assertAllCallsRedacted(calls, RAW_ADDRESSES);

        calls.length = 0;
        mock.mockClear();
        const second = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 60_000,
          cache,
          fetchFn: mock,
        });
        expect(second.account_id).toBe(TEST_ADDRESS);
        expect(mock).not.toHaveBeenCalled();
        const hit = calls.find((c) => c.message === 'Horizon cache hit');
        const hitCtx = requireContext(hit);
        expect(hitCtx.balancesCount).toBe(2);
        expect(hitCtx.cacheKey).not.toContain(TEST_ADDRESS);
        const fetchCalls = calls.filter((c) => c.message === 'Horizon fetch start');
        expect(fetchCalls.length).toBe(0);
        assertAllCallsRedacted(calls, RAW_ADDRESSES);
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });

    it('emits a cache-disabled debug line when ttl is 0', async () => {
      const { calls, restore } = captureDebugCalls();
      const account = makeAccount(TEST_ADDRESS);
      const mock = makeMockFetch(async () => makeMockResponse(200, account));
      loggerModule.logger.setDebugMode(true);

      try {
        await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 0,
          fetchFn: mock,
        });
        expect(mock).toHaveBeenCalledTimes(1);
        const disabled = calls.find((c) => c.message === 'Horizon cache disabled (ttl=0)');
        const disabledCtx = requireContext(disabled);
        expect(disabledCtx.cacheTtlMs).toBe(0);
        assertAllCallsRedacted(calls, RAW_ADDRESSES);
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });
  });

  describe('RPC fallback path: fallback switch, success, and exhaustion debug logs redacted', () => {
    it('redacts primary/fallback URLs and error messages when fallback succeeds', async () => {
      const { calls, restore } = captureDebugCalls();
      const account = makeAccount(FALLBACK_ADDRESS);
      const primaryErrBody = { type: 'server_error', title: 'Service Unavailable', status: 503, detail: `Upstream error while querying account ${TEST_ADDRESS_2}` };
      const mock = makeMockFetch(async (url) => {
        if (typeof url === 'string' && url.startsWith(PRIMARY_HORIZON)) {
          return makeMockResponse(503, primaryErrBody);
        }
        return makeMockResponse(200, account);
      });
      loggerModule.logger.setDebugMode(true);
      const expectedTestAddr = redactForAddress(TEST_ADDRESS);
      const expectedAddr2 = redactForAddress(TEST_ADDRESS_2);

      try {
        const result = await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 0,
          horizonUrlFallback: FALLBACK_HORIZON,
          fetchFn: mock,
        });
        expect(result.account_id).toBe(FALLBACK_ADDRESS);
        expect(mock).toHaveBeenCalledTimes(2);

        const switchLog = calls.find((c) =>
          c.message === 'Horizon RPC fallback: primary exhausted, switching to fallback URL',
        );
        const switchCtx = requireContext(switchLog);
        expect(switchCtx.horizonUrlFallback).toContain(FALLBACK_HORIZON.replace(/\/+$/, ''));
        expect(switchCtx.primaryStatusCode).toBe(503);
        expect(switchCtx.primaryErrorMessage).not.toContain(TEST_ADDRESS_2);
        expect(switchCtx.primaryErrorMessage).toContain(expectedAddr2);

        const fallbackSuccess = calls.find(
          (c) => c.message === 'Horizon RPC fallback succeeded',
        );
        const fallbackSuccessCtx = requireContext(fallbackSuccess);
        expect(fallbackSuccessCtx.fallbackAttempts).toBeDefined();
        expect(fallbackSuccessCtx.fallbackLatencyMs).toBeDefined();

        const fallbackFetches = calls.filter(
          (c) => c.message === 'Horizon fetch start' && requireContext(c).endpointKind === 'fallback',
        );
        expect(fallbackFetches.length).toBe(1);
        expect(requireContext(fallbackFetches[0]).url).toContain(expectedTestAddr);

        assertAllCallsRedacted(calls, RAW_ADDRESSES);
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });

    it('redacts both primary and fallback errors when fallback is exhausted', async () => {
      const { calls, restore } = captureDebugCalls();
      const primaryErrBody = { type: 'server_error', title: 'Bad Gateway', status: 502, detail: `Connecting to account ${TEST_ADDRESS} failed` };
      const fallbackErrBody = { type: 'server_error', title: 'Service Unavailable', status: 503, detail: `Fallback also down for ${TEST_ADDRESS_2}` };
      const mock = makeMockFetch(async (url) => {
        if (typeof url === 'string' && url.startsWith(PRIMARY_HORIZON)) {
          return makeMockResponse(502, primaryErrBody);
        }
        return makeMockResponse(503, fallbackErrBody);
      });
      loggerModule.logger.setDebugMode(true);
      const expectedTestAddr = redactForAddress(TEST_ADDRESS);
      const expectedAddr2 = redactForAddress(TEST_ADDRESS_2);

      try {
        await expect(fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 0,
          horizonUrlFallback: FALLBACK_HORIZON,
          fetchFn: mock,
        })).rejects.toMatchObject({ statusCode: 503 });
        expect(mock).toHaveBeenCalledTimes(2);

        const exhausted = calls.find(
          (c) => c.message === 'Horizon RPC fallback exhausted',
        );
        const exhaustedCtx = requireContext(exhausted);
        expect(exhaustedCtx.primaryStatusCode).toBe(502);
        expect(exhaustedCtx.fallbackStatusCode).toBe(503);
        expect(exhaustedCtx.primaryErrorMessage).not.toContain(TEST_ADDRESS);
        expect(exhaustedCtx.fallbackErrorMessage).not.toContain(TEST_ADDRESS_2);
        expect(exhaustedCtx.primaryErrorMessage).toContain(expectedTestAddr);
        expect(exhaustedCtx.fallbackErrorMessage).toContain(expectedAddr2);

        assertAllCallsRedacted(calls, RAW_ADDRESSES);
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });
  });

  describe('safeAccountSummary: never emits sensitive account fields into debug context', () => {
    it('strips balance, sequence, sponsor counts and raw id from success context', async () => {
      const { calls, restore } = captureDebugCalls();
      const account = makeAccount(TEST_ADDRESS);
      const mock = makeMockFetch(async () => makeMockResponse(200, account));
      loggerModule.logger.setDebugMode(true);

      try {
        await fetchAccount(PRIMARY_HORIZON, TEST_ADDRESS, {
          maxRetries: 0,
          cacheTtlMs: 0,
          fetchFn: mock,
        });
        expect(mock).toHaveBeenCalledTimes(1);
        const success = calls.find((c) => c.message === 'Horizon fetch success');
        const ctx = requireContext(success);
        expect(ctx.sequence).toBeUndefined();
        expect(ctx.balances).toBeUndefined();
        expect(ctx.id).toBeUndefined();
        expect(ctx.account_id).toBeUndefined();
        expect(ctx.num_sponsoring).toBeUndefined();
        expect(ctx.num_sponsored).toBeUndefined();
        expect(ctx.balancesCount).toBe(2);
        expect(ctx.creditTrustlineCount).toBe(1);
        expect(ctx.hasNativeBalance).toBe(true);
        expect(ctx.subentryCount).toBe(2);
      } finally {
        jest.restoreAllMocks();
        restore();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Wave #31 — Auto wallet labels
// ---------------------------------------------------------------------------

import {
  deriveWalletLabel,
  applyWalletLabels,
  ALL_WALLET_LABELS,
  WalletLabel,
  WalletLabelInput,
} from '../src/horizon';

describe('deriveWalletLabel', () => {
  it('returns wallet: horizon-error when horizonError is true', () => {
    expect(deriveWalletLabel({ accountFunded: false, trustlineExists: false, xlmReserveMet: false, horizonError: true }))
      .toBe('wallet: horizon-error');
  });

  it('returns wallet: unfunded when account is not funded (no error)', () => {
    expect(deriveWalletLabel({ accountFunded: false, trustlineExists: false, xlmReserveMet: false }))
      .toBe('wallet: unfunded');
  });

  it('returns wallet: trustline-missing when funded but no trustline', () => {
    expect(deriveWalletLabel({ accountFunded: true, trustlineExists: false, xlmReserveMet: true }))
      .toBe('wallet: trustline-missing');
  });

  it('returns wallet: reserve-low when funded + trustline but reserve not met', () => {
    expect(deriveWalletLabel({ accountFunded: true, trustlineExists: true, xlmReserveMet: false }))
      .toBe('wallet: reserve-low');
  });

  it('returns wallet: funded when all checks pass', () => {
    expect(deriveWalletLabel({ accountFunded: true, trustlineExists: true, xlmReserveMet: true }))
      .toBe('wallet: funded');
  });

  it('horizon-error takes precedence over unfunded', () => {
    expect(deriveWalletLabel({ accountFunded: false, trustlineExists: false, xlmReserveMet: false, horizonError: true }))
      .toBe('wallet: horizon-error');
  });
});

describe('ALL_WALLET_LABELS', () => {
  it('contains all five wallet label variants', () => {
    const expected: WalletLabel[] = [
      'wallet: funded',
      'wallet: unfunded',
      'wallet: trustline-missing',
      'wallet: reserve-low',
      'wallet: horizon-error',
    ];
    expect(ALL_WALLET_LABELS).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// applyWalletLabels
// ---------------------------------------------------------------------------

function makeOctokit(overrides: {
  listLabelsOnIssue?: jest.Mock;
  addLabels?: jest.Mock;
  removeLabel?: jest.Mock;
} = {}) {
  return {
    rest: {
      issues: {
        listLabelsOnIssue: overrides.listLabelsOnIssue ?? jest.fn().mockResolvedValue({ data: [] }),
        addLabels: overrides.addLabels ?? jest.fn().mockResolvedValue({}),
        removeLabel: overrides.removeLabel ?? jest.fn().mockResolvedValue({}),
      },
    },
  };
}

describe('applyWalletLabels', () => {
  const OWNER = 'test-org';
  const REPO = 'test-repo';
  const ISSUE = 42;

  describe('success paths', () => {
    it('adds the correct label for a fully funded account', async () => {
      const addLabels = jest.fn().mockResolvedValue({});
      const octokit = makeOctokit({ addLabels });
      const input: WalletLabelInput = { accountFunded: true, trustlineExists: true, xlmReserveMet: true };
      const result = await applyWalletLabels(octokit, OWNER, REPO, ISSUE, input);
      expect(result.applied).toBe('wallet: funded');
      expect(result.error).toBeUndefined();
      expect(addLabels).toHaveBeenCalledWith({
        owner: OWNER, repo: REPO, issue_number: ISSUE, labels: ['wallet: funded'],
      });
    });

    it('adds wallet: unfunded for an unfunded account', async () => {
      const addLabels = jest.fn().mockResolvedValue({});
      const octokit = makeOctokit({ addLabels });
      const result = await applyWalletLabels(octokit, OWNER, REPO, ISSUE, {
        accountFunded: false, trustlineExists: false, xlmReserveMet: false,
      });
      expect(result.applied).toBe('wallet: unfunded');
    });

    it('adds wallet: trustline-missing when trustline absent', async () => {
      const result = await applyWalletLabels(makeOctokit(), OWNER, REPO, ISSUE, {
        accountFunded: true, trustlineExists: false, xlmReserveMet: true,
      });
      expect(result.applied).toBe('wallet: trustline-missing');
    });

    it('adds wallet: reserve-low when reserve not met', async () => {
      const result = await applyWalletLabels(makeOctokit(), OWNER, REPO, ISSUE, {
        accountFunded: true, trustlineExists: true, xlmReserveMet: false,
      });
      expect(result.applied).toBe('wallet: reserve-low');
    });

    it('adds wallet: horizon-error when Horizon returned an error', async () => {
      const result = await applyWalletLabels(makeOctokit(), OWNER, REPO, ISSUE, {
        accountFunded: false, trustlineExists: false, xlmReserveMet: false, horizonError: true,
      });
      expect(result.applied).toBe('wallet: horizon-error');
    });
  });

  describe('stale label removal', () => {
    it('removes stale wallet labels that are currently on the issue', async () => {
      const removeLabel = jest.fn().mockResolvedValue({});
      const listLabelsOnIssue = jest.fn().mockResolvedValue({
        data: [
          { name: 'wallet: unfunded' },
          { name: 'wallet: reserve-low' },
          { name: 'bug' },
        ],
      });
      const octokit = makeOctokit({ listLabelsOnIssue, removeLabel });
      const result = await applyWalletLabels(octokit, OWNER, REPO, ISSUE, {
        accountFunded: true, trustlineExists: true, xlmReserveMet: true,
      });
      expect(result.applied).toBe('wallet: funded');
      expect(result.removed).toContain('wallet: unfunded');
      expect(result.removed).toContain('wallet: reserve-low');
      expect(result.removed).not.toContain('bug');
      expect(removeLabel).toHaveBeenCalledTimes(2);
    });

    it('does not remove the label that is about to be applied', async () => {
      const removeLabel = jest.fn().mockResolvedValue({});
      const listLabelsOnIssue = jest.fn().mockResolvedValue({
        data: [{ name: 'wallet: funded' }],
      });
      const octokit = makeOctokit({ listLabelsOnIssue, removeLabel });
      await applyWalletLabels(octokit, OWNER, REPO, ISSUE, {
        accountFunded: true, trustlineExists: true, xlmReserveMet: true,
      });
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it('skips removal when removeStale is false', async () => {
      const removeLabel = jest.fn();
      const listLabelsOnIssue = jest.fn();
      const octokit = makeOctokit({ removeLabel, listLabelsOnIssue });
      await applyWalletLabels(octokit, OWNER, REPO, ISSUE,
        { accountFunded: true, trustlineExists: true, xlmReserveMet: true },
        { removeStale: false },
      );
      expect(listLabelsOnIssue).not.toHaveBeenCalled();
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it('continues applying the new label even if a stale removal throws', async () => {
      const removeLabel = jest.fn().mockRejectedValue(new Error('404 not found'));
      const addLabels = jest.fn().mockResolvedValue({});
      const listLabelsOnIssue = jest.fn().mockResolvedValue({
        data: [{ name: 'wallet: unfunded' }],
      });
      const octokit = makeOctokit({ removeLabel, addLabels, listLabelsOnIssue });
      const result = await applyWalletLabels(octokit, OWNER, REPO, ISSUE, {
        accountFunded: true, trustlineExists: true, xlmReserveMet: true,
      });
      // removal failed silently, add still called
      expect(addLabels).toHaveBeenCalled();
      expect(result.error).toBeUndefined();
    });
  });

  describe('failure paths', () => {
    it('returns an error string (not throws) when addLabels fails', async () => {
      const addLabels = jest.fn().mockRejectedValue(new Error('Resource not accessible by token'));
      const octokit = makeOctokit({ addLabels });
      const result = await applyWalletLabels(octokit, OWNER, REPO, ISSUE, {
        accountFunded: true, trustlineExists: true, xlmReserveMet: true,
      });
      expect(result.error).toContain('Resource not accessible');
      expect(result.applied).toBe('wallet: funded');
    });

    it('returns an error string when listLabelsOnIssue fails', async () => {
      const listLabelsOnIssue = jest.fn().mockRejectedValue(new Error('API rate limit exceeded'));
      const octokit = makeOctokit({ listLabelsOnIssue });
      const result = await applyWalletLabels(octokit, OWNER, REPO, ISSUE, {
        accountFunded: true, trustlineExists: true, xlmReserveMet: true,
      });
      expect(result.error).toContain('API rate limit');
    });
  });

  describe('removed array', () => {
    it('is empty when no stale labels were present', async () => {
      const result = await applyWalletLabels(makeOctokit(), OWNER, REPO, ISSUE, {
        accountFunded: true, trustlineExists: true, xlmReserveMet: true,
      });
      expect(result.removed).toEqual([]);
    });
  });
});
