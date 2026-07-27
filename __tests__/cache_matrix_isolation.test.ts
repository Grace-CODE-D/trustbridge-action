import { fetchAccount, HorizonAccount } from '../src/horizon';
import { SimpleCache } from '../src/cache';
import { globalMetrics } from '../src/metrics';
import { redactStellarAddress } from '../src/logger';
import type { Request, RequestInit, Response } from 'node-fetch';

/**
 * Regression coverage for Issue #75: prove that the in-memory Horizon
 * account cache cannot cross-contaminate results across distinct
 * "matrix dimensions" — different Horizon base URLs (e.g. mainnet vs
 * testnet legs of a matrix build) and different Stellar addresses — even
 * when a single `SimpleCache` instance is shared, and that cache hit/miss
 * metrics are emitted with redacted key dimensions.
 */

const ADDRESS_A = `G${'A'.repeat(55)}`;
const ADDRESS_B = `G${'B'.repeat(55)}`;
const MAINNET_HORIZON = 'https://horizon.stellar.org';
const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';

function makeAccount(address: string, marker: string): HorizonAccount {
  return {
    id: address,
    account_id: address,
    sequence: marker,
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        balance: marker,
        asset_type: 'native',
        buying_liabilities: '0',
        selling_liabilities: '0',
      },
    ],
  };
}

type FetchArg = string | Request;
type MockFetch = jest.Mock<Promise<Response>, [FetchArg, RequestInit?]>;

function makeMockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

/** Fetch stub that returns a distinct account keyed by URL+address, so a
 * cross-contaminated cache lookup would be caught by comparing identities. */
function makeIsolationAwareFetch(): MockFetch {
  return jest.fn<Promise<Response>, [FetchArg, RequestInit?]>(async (url) => {
    const target = url.toString();
    if (target.includes(TESTNET_HORIZON)) {
      return makeMockResponse(200, makeAccount(ADDRESS_A, 'testnet-A'));
    }
    if (target.includes(ADDRESS_B)) {
      return makeMockResponse(200, makeAccount(ADDRESS_B, 'mainnet-B'));
    }
    return makeMockResponse(200, makeAccount(ADDRESS_A, 'mainnet-A'));
  });
}

describe('matrix cache isolation (Issue #75)', () => {
  beforeEach(() => {
    globalMetrics.reset();
  });

  it('does not share cache entries across different horizon_url matrix legs for the same address', async () => {
    const cache = new SimpleCache();
    const mock = makeIsolationAwareFetch();

    const mainnetResult = await fetchAccount(MAINNET_HORIZON, ADDRESS_A, {
      cacheTtlMs: 60_000,
      cache,
      fetchFn: mock,
    });
    const testnetResult = await fetchAccount(TESTNET_HORIZON, ADDRESS_A, {
      cacheTtlMs: 60_000,
      cache,
      fetchFn: mock,
    });

    expect(mainnetResult.sequence).toBe('mainnet-A');
    expect(testnetResult.sequence).toBe('testnet-A');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(cache.getStats().size).toBe(2);
  });

  it('does not share cache entries across different addresses on the same horizon_url', async () => {
    const cache = new SimpleCache();
    const mock = makeIsolationAwareFetch();

    const resultA = await fetchAccount(MAINNET_HORIZON, ADDRESS_A, {
      cacheTtlMs: 60_000,
      cache,
      fetchFn: mock,
    });
    const resultB = await fetchAccount(MAINNET_HORIZON, ADDRESS_B, {
      cacheTtlMs: 60_000,
      cache,
      fetchFn: mock,
    });

    expect(resultA.sequence).toBe('mainnet-A');
    expect(resultB.sequence).toBe('mainnet-B');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(cache.getStats().size).toBe(2);
  });

  it('serves a cache hit for a repeated (horizon_url, address) key without a second network call', async () => {
    const cache = new SimpleCache();
    const mock = makeIsolationAwareFetch();

    const first = await fetchAccount(MAINNET_HORIZON, ADDRESS_A, {
      cacheTtlMs: 60_000,
      cache,
      fetchFn: mock,
    });
    const second = await fetchAccount(MAINNET_HORIZON, ADDRESS_A, {
      cacheTtlMs: 60_000,
      cache,
      fetchFn: mock,
    });

    expect(first.sequence).toBe('mainnet-A');
    expect(second.sequence).toBe('mainnet-A');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('emits distinguishable hit/miss metrics per matrix leg without leaking raw addresses', async () => {
    const cache = new SimpleCache();
    const mock = makeIsolationAwareFetch();

    // Miss (mainnet, A) -> populate
    await fetchAccount(MAINNET_HORIZON, ADDRESS_A, { cacheTtlMs: 60_000, cache, fetchFn: mock });
    // Hit (mainnet, A)
    await fetchAccount(MAINNET_HORIZON, ADDRESS_A, { cacheTtlMs: 60_000, cache, fetchFn: mock });
    // Miss (testnet, A) — different matrix leg, must not reuse the mainnet hit
    await fetchAccount(TESTNET_HORIZON, ADDRESS_A, { cacheTtlMs: 60_000, cache, fetchFn: mock });

    expect(globalMetrics.getCounter('horizon_cache_hit')).toBe(1);
    expect(globalMetrics.getCounter('horizon_cache_miss')).toBe(2);

    const summary = globalMetrics.getSummary();
    const hitPoint = summary.metrics.find((m) => m.name === 'horizon_cache_hit');
    const missPoints = summary.metrics.filter((m) => m.name === 'horizon_cache_miss');

    expect(hitPoint?.tags?.stellarAddress).toBe(redactStellarAddress(ADDRESS_A));
    expect(hitPoint?.tags?.stellarAddress).not.toBe(ADDRESS_A);
    expect(hitPoint?.tags?.horizonUrl).not.toContain(ADDRESS_A);

    // Two distinct horizon_url dimensions among the miss metrics.
    const missHorizonUrls = new Set(missPoints.map((m) => m.tags?.horizonUrl));
    expect(missHorizonUrls.size).toBe(2);

    // Never leak the full 56-char address anywhere in the metrics export.
    expect(globalMetrics.toJSON()).not.toContain(ADDRESS_A);
  });

  it('does not cache disabled (ttl=0) lookups, so every matrix leg call reaches the network', async () => {
    const mock = makeIsolationAwareFetch();

    await fetchAccount(MAINNET_HORIZON, ADDRESS_A, { cacheTtlMs: 0, fetchFn: mock });
    await fetchAccount(MAINNET_HORIZON, ADDRESS_A, { cacheTtlMs: 0, fetchFn: mock });

    expect(mock).toHaveBeenCalledTimes(2);
    expect(globalMetrics.getCounter('horizon_cache_hit')).toBe(0);
    expect(globalMetrics.getCounter('horizon_cache_miss')).toBe(0);
  });
});
