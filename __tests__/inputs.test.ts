import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getErrorMessage,
  parseAssigneeAddressMap,
  parseBooleanInput,
  parseNumberInput,
  resolveAddressFromAssigneeMap,
} from '../src/inputs';

const VALID_G = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const VALID_G_ALT = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

describe('parseBooleanInput', () => {
  it.each(['true', 'TRUE', '1', 'yes', ' Yes '])(
    'parses %s as true',
    (value) => {
      expect(parseBooleanInput(value, false)).toBe(true);
    },
  );

  it.each(['false', 'FALSE', '0', 'no', ' No '])(
    'parses %s as false',
    (value) => {
      expect(parseBooleanInput(value, true)).toBe(false);
    },
  );

  it('falls back to the default for blank values', () => {
    expect(parseBooleanInput('', true)).toBe(true);
  });

  it('falls back to the default for unknown values', () => {
    expect(parseBooleanInput('sometimes', false)).toBe(false);
  });
});

describe('parseNumberInput', () => {
  it('returns default value for blank inputs', () => {
    expect(parseNumberInput('', 20)).toBe(20);
  });

  it('parses numeric strings correctly', () => {
    expect(parseNumberInput(' 1500 ', 1000)).toBe(1500);
  });

  it('throws when input is not numeric', () => {
    expect(() => parseNumberInput('abc', 1000)).toThrow(
      'Expected a numeric input, but received: "abc"',
    );
  });

  it('throws when input is below min', () => {
    expect(() => parseNumberInput('0', 1000, { min: 1 })).toThrow(
      'Value must be at least 1. Received: 0',
    );
  });

  it('throws when input is above max', () => {
    expect(() => parseNumberInput('100', 10, { max: 50 })).toThrow(
      'Value must be at most 50. Received: 100',
    );
  });
});

describe('getErrorMessage', () => {
  it('reads Error messages and stringifies unknown values', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
    expect(getErrorMessage('plain')).toBe('plain');
  });
});

describe('parseAssigneeAddressMap', () => {
  it('returns an empty map for blank input', () => {
    expect(parseAssigneeAddressMap('')).toEqual({});
    expect(parseAssigneeAddressMap('   ')).toEqual({});
  });

  it('parses inline JSON and lowercases usernames (hit)', () => {
    const map = parseAssigneeAddressMap(
      JSON.stringify({ Alice: VALID_G, bob: VALID_G_ALT }),
    );
    expect(map.alice).toBe(VALID_G);
    expect(map.bob).toBe(VALID_G_ALT);
  });

  it('loads a roster JSON file from a relative path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-roster-'));
    const filePath = path.join(dir, 'wallets.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({ contributor: VALID_G }),
      'utf8',
    );

    const map = parseAssigneeAddressMap('wallets.json', { workspaceRoot: dir });
    expect(map.contributor).toBe(VALID_G);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseAssigneeAddressMap('{not-json')).toThrow(/invalid JSON/i);
  });

  it('throws when JSON is not an object', () => {
    expect(() => parseAssigneeAddressMap('["alice"]')).toThrow(/JSON object/i);
    expect(() => parseAssigneeAddressMap('null')).toThrow(/JSON object/i);
  });

  it('throws when a map value is not a string', () => {
    expect(() => parseAssigneeAddressMap('{"alice":123}')).toThrow(
      /must be a string Stellar G-address/,
    );
  });

  it('throws when the roster file is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-roster-miss-'));
    expect(() =>
      parseAssigneeAddressMap('missing-roster.json', { workspaceRoot: dir }),
    ).toThrow(/file not found/i);
  });
});

describe('resolveAddressFromAssigneeMap', () => {
  const map = parseAssigneeAddressMap(
    JSON.stringify({ Alice: VALID_G, bob: VALID_G_ALT }),
  );

  it('resolves a hit case-insensitively', () => {
    expect(resolveAddressFromAssigneeMap(map, 'alice')).toBe(VALID_G);
    expect(resolveAddressFromAssigneeMap(map, 'ALICE')).toBe(VALID_G);
    expect(resolveAddressFromAssigneeMap(map, 'Bob')).toBe(VALID_G_ALT);
  });

  it('fails with an actionable message when the assignee is missing (miss)', () => {
    expect(() => resolveAddressFromAssigneeMap(map, 'charlie')).toThrow(
      /Assignee "charlie" is not present in assignee_address_map/,
    );
  });

  it('fails when no assignee login is available', () => {
    expect(() => resolveAddressFromAssigneeMap(map, undefined)).toThrow(
      /no assignee login was found/i,
    );
    expect(() => resolveAddressFromAssigneeMap(map, '  ')).toThrow(
      /no assignee login was found/i,
    );
  });
});
