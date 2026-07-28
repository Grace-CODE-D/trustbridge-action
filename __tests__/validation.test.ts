import {
  validateContractAddress,
  computeBaseReserveRequirement,
  validateDynamicReserve,
  computeEffectiveReserveRequirement,
  AccountReserveState,
} from '../src/validation';

const VALID_CONTRACT_ADDRESS = 'C' + 'A'.repeat(55);

describe('validateContractAddress', () => {
  it('accepts a well-formed 56-character contract address', () => {
    const result = validateContractAddress(VALID_CONTRACT_ADDRESS);
    expect(result).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('rejects an empty address', () => {
    const result = validateContractAddress('');
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['Contract address cannot be empty']);
  });

  it('rejects addresses not starting with C', () => {
    const result = validateContractAddress('G' + 'A'.repeat(55));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /must start with "C"/.test(e))).toBe(true);
  });

  it('rejects addresses with the wrong length', () => {
    const result = validateContractAddress('CSHORT');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /56 characters/.test(e))).toBe(true);
  });

  it('rejects addresses with invalid base32 characters', () => {
    const result = validateContractAddress('C' + '0'.repeat(55));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /StrKey format/.test(e))).toBe(true);
  });

  it('trims surrounding whitespace before validating', () => {
    const result = validateContractAddress(`  ${VALID_CONTRACT_ADDRESS}  `);
    expect(result.valid).toBe(true);
  });
});

describe('computeBaseReserveRequirement', () => {
  it('computes the minimum for a fresh account with no subentries', () => {
    const state: AccountReserveState = { subentryCount: 0, numSponsoring: 0, numSponsored: 0 };
    expect(computeBaseReserveRequirement(state)).toBe(1); // (2 + 0 + 0 - 0) * 0.5
  });

  it('increases the requirement for each subentry (trustline, offer, etc.)', () => {
    const state: AccountReserveState = { subentryCount: 4, numSponsoring: 0, numSponsored: 0 };
    expect(computeBaseReserveRequirement(state)).toBe(3); // (2 + 4) * 0.5
  });

  it('increases the requirement for reserves this account sponsors for others', () => {
    const state: AccountReserveState = { subentryCount: 0, numSponsoring: 6, numSponsored: 0 };
    expect(computeBaseReserveRequirement(state)).toBe(4); // (2 + 6) * 0.5
  });

  it('reduces the requirement for reserves sponsored by others', () => {
    const state: AccountReserveState = { subentryCount: 4, numSponsoring: 0, numSponsored: 4 };
    expect(computeBaseReserveRequirement(state)).toBe(1); // (2 + 4 - 4) * 0.5
  });

  it('never goes below zero even when sponsorship outweighs subentries', () => {
    const state: AccountReserveState = { subentryCount: 0, numSponsoring: 0, numSponsored: 10 };
    expect(computeBaseReserveRequirement(state)).toBe(0);
  });

  it('treats negative or non-finite counters as zero rather than lowering the requirement', () => {
    const state: AccountReserveState = { subentryCount: -5, numSponsoring: NaN, numSponsored: -3 };
    expect(computeBaseReserveRequirement(state)).toBe(1); // falls back to the fresh-account baseline
  });

  it('honors a custom base reserve value', () => {
    const state: AccountReserveState = { subentryCount: 2, numSponsoring: 0, numSponsored: 0 };
    expect(computeBaseReserveRequirement(state, 1)).toBe(4); // (2 + 2) * 1
  });
});

describe('validateDynamicReserve', () => {
  it('passes when the actual balance comfortably clears the computed requirement', () => {
    const state: AccountReserveState = { subentryCount: 2, numSponsoring: 0, numSponsored: 0 };
    const result = validateDynamicReserve(state, 10);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.baseReserveRequirement).toBe(2); // (2 + 2) * 0.5
    expect(result.totalRequirement).toBe(2);
  });

  it('fails when the actual balance is below the computed requirement (failure path)', () => {
    const state: AccountReserveState = { subentryCount: 10, numSponsoring: 0, numSponsored: 0 };
    const result = validateDynamicReserve(state, 1);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/below the dynamically computed reserve requirement/);
    expect(result.baseReserveRequirement).toBe(6); // (2 + 10) * 0.5
  });

  it('applies an additional safety buffer on top of the base requirement', () => {
    const state: AccountReserveState = { subentryCount: 0, numSponsoring: 0, numSponsored: 0 };
    const result = validateDynamicReserve(state, 1.2, { bufferXlm: 0.5 });
    expect(result.bufferXlm).toBe(0.5);
    expect(result.totalRequirement).toBe(1.5); // 1 (base) + 0.5 (buffer)
    expect(result.valid).toBe(false); // 1.2 < 1.5
  });

  it('warns when the passing margin is thin', () => {
    const state: AccountReserveState = { subentryCount: 0, numSponsoring: 0, numSponsored: 0 };
    const result = validateDynamicReserve(state, 1.1); // requirement is 1, margin 0.1
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => /thin/.test(w) || /headroom/.test(w))).toBe(true);
  });

  it('treats a non-finite actual balance as an error', () => {
    const state: AccountReserveState = { subentryCount: 0, numSponsoring: 0, numSponsored: 0 };
    const result = validateDynamicReserve(state, NaN);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/actualXlmBalance must be a finite number/);
  });

  it('warns but still computes a safe result for malformed account counters', () => {
    const state: AccountReserveState = { subentryCount: -1, numSponsoring: 0, numSponsored: 0 };
    const result = validateDynamicReserve(state, 1);
    expect(result.warnings.some((w) => /subentryCount was invalid/.test(w))).toBe(true);
    expect(result.baseReserveRequirement).toBe(1);
  });
});

describe('computeEffectiveReserveRequirement', () => {
  it('never drops below the maintainer-configured static floor', () => {
    const state: AccountReserveState = { subentryCount: 0, numSponsoring: 0, numSponsored: 0 };
    // configured floor (5) is higher than the dynamic requirement (1)
    expect(computeEffectiveReserveRequirement(5, state)).toBe(5);
  });

  it('raises the requirement above the static floor when account state demands more', () => {
    const state: AccountReserveState = { subentryCount: 10, numSponsoring: 0, numSponsored: 0 };
    // configured floor (1.5) is lower than the dynamic requirement (6)
    expect(computeEffectiveReserveRequirement(1.5, state)).toBe(6);
  });

  it('adds the configured buffer on top of the dynamic requirement', () => {
    const state: AccountReserveState = { subentryCount: 10, numSponsoring: 0, numSponsored: 0 };
    expect(computeEffectiveReserveRequirement(1.5, state, { bufferXlm: 2 })).toBe(8); // 6 + 2
  });
});
