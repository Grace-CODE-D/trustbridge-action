/**
 * action.yml ↔ schemas/action-inputs.schema.json sync tests.
 *
 * CI fails when:
 *  1. An input in action.yml has no matching property in the schema.
 *  2. A property in the schema has no matching input in action.yml.
 *  3. A `required: true` action.yml input is absent from schema `required[]`.
 *  4. A `required: false` action.yml input is incorrectly in schema `required[]`.
 *  5. The schema itself is not valid parseable JSON.
 *
 * The tests use Node's built-in `fs` module and a lightweight hand-rolled
 * YAML key extractor — no yaml-parser runtime dependency needed because
 * action.yml has a predictable, stable structure (top-level `inputs:` map
 * with string-keyed entries).
 *
 * Intentional mismatch detection is also exercised: the test suite includes
 * cases that construct a tampered schema/action snapshot and asserts that
 * the sync logic would catch the drift.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..');
const ACTION_YML_PATH = path.join(REPO_ROOT, 'action.yml');
const SCHEMA_PATH = path.join(REPO_ROOT, 'schemas', 'action-inputs.schema.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse `action.yml` without a YAML library by scanning for the `inputs:`
 * section and collecting every top-level input key.
 *
 * The parser is intentionally narrow — it only needs to handle the specific
 * structure of this action.yml file:
 *
 *   inputs:
 *     some_input:          ← 2-space indented key under `inputs:`
 *       description: ...
 *       required: false    ← optional; absence means false
 *       default: '...'
 *
 * Returns a map of inputName → { required: boolean }.
 */
function parseActionYmlInputs(yamlText: string): Map<string, { required: boolean }> {
  const inputs = new Map<string, { required: boolean }>();
  const lines = yamlText.split('\n');

  let inInputsSection = false;
  let currentInputName: string | null = null;
  let currentRequired = false;

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Detect top-level `inputs:` section start
    if (/^inputs:\s*$/.test(line)) {
      inInputsSection = true;
      continue;
    }

    // A new top-level section (no indent) ends the inputs block
    if (inInputsSection && /^[a-zA-Z_]/.test(line) && !/^\s/.test(line)) {
      if (currentInputName !== null) {
        inputs.set(currentInputName, { required: currentRequired });
      }
      inInputsSection = false;
      currentInputName = null;
      continue;
    }

    if (!inInputsSection) continue;

    // Skip comment-only lines
    if (/^\s*#/.test(line)) continue;

    // 2-space indented key directly under `inputs:` → input name
    const inputMatch = line.match(/^  ([a-zA-Z_][a-zA-Z0-9_]*):\s*$/);
    if (inputMatch) {
      if (currentInputName !== null) {
        inputs.set(currentInputName, { required: currentRequired });
      }
      currentInputName = inputMatch[1]!;
      currentRequired = false; // default: not required
      continue;
    }

    // 4-space indented `required: true/false`
    const requiredMatch = line.match(/^    required:\s*(true|false)\s*$/);
    if (requiredMatch && currentInputName !== null) {
      currentRequired = requiredMatch[1] === 'true';
      continue;
    }
  }

  // Flush last input
  if (currentInputName !== null) {
    inputs.set(currentInputName, { required: currentRequired });
  }

  return inputs;
}

/**
 * Load and parse the JSON schema. Returns the parsed object or throws on
 * invalid JSON.
 */
function loadSchema(schemaPath: string): {
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
  additionalProperties?: boolean;
} {
  const raw = fs.readFileSync(schemaPath, 'utf8');
  return JSON.parse(raw) as {
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/**
 * Find inputs present in action.yml but missing from schema properties.
 */
function findInputsMissingFromSchema(
  actionInputs: Map<string, { required: boolean }>,
  schemaProperties: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  for (const name of actionInputs.keys()) {
    if (!(name in schemaProperties)) {
      missing.push(name);
    }
  }
  return missing;
}

/**
 * Find schema properties that have no corresponding action.yml input.
 * (Schema drift — property added to schema but not to action.yml.)
 */
function findSchemaPropertiesNotInAction(
  actionInputs: Map<string, { required: boolean }>,
  schemaProperties: Record<string, unknown>,
): string[] {
  const orphaned: string[] = [];
  for (const name of Object.keys(schemaProperties)) {
    if (!actionInputs.has(name)) {
      orphaned.push(name);
    }
  }
  return orphaned;
}

/**
 * Find action.yml `required: true` inputs absent from schema `required[]`.
 */
function findRequiredInputsMissingFromSchemaRequired(
  actionInputs: Map<string, { required: boolean }>,
  schemaRequired: string[],
): string[] {
  const missing: string[] = [];
  for (const [name, meta] of actionInputs.entries()) {
    if (meta.required && !schemaRequired.includes(name)) {
      missing.push(name);
    }
  }
  return missing;
}

/**
 * Find schema `required[]` entries that are NOT `required: true` in action.yml.
 */
function findSchemaRequiredNotRequiredInAction(
  actionInputs: Map<string, { required: boolean }>,
  schemaRequired: string[],
): string[] {
  return schemaRequired.filter((name) => {
    const meta = actionInputs.get(name);
    return meta === undefined || !meta.required;
  });
}

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------

describe('action.yml ↔ schemas/action-inputs.schema.json sync', () => {

  let actionInputs: Map<string, { required: boolean }>;
  let schema: ReturnType<typeof loadSchema>;

  beforeAll(() => {
    const yamlText = fs.readFileSync(ACTION_YML_PATH, 'utf8');
    actionInputs = parseActionYmlInputs(yamlText);
    schema = loadSchema(SCHEMA_PATH);
  });

  // ── 1. Schema file exists and is valid JSON ───────────────────────────────

  it('schema file exists at schemas/action-inputs.schema.json', () => {
    expect(fs.existsSync(SCHEMA_PATH)).toBe(true);
  });

  it('schema file is valid JSON', () => {
    expect(() => loadSchema(SCHEMA_PATH)).not.toThrow();
  });

  it('schema has a "properties" object', () => {
    expect(schema.properties).toBeDefined();
    expect(typeof schema.properties).toBe('object');
  });

  it('schema has additionalProperties: false (no undeclared inputs slip through)', () => {
    expect(schema.additionalProperties).toBe(false);
  });

  // ── 2. action.yml parser sanity ───────────────────────────────────────────

  it('parses at least 10 inputs from action.yml', () => {
    expect(actionInputs.size).toBeGreaterThanOrEqual(10);
  });

  it('finds github_token as required:true in action.yml', () => {
    expect(actionInputs.get('github_token')?.required).toBe(true);
  });

  it('finds fail_on_missing as required:false in action.yml', () => {
    expect(actionInputs.get('fail_on_missing')?.required).toBe(false);
  });

  it('finds check_ledger_freshness in action.yml', () => {
    expect(actionInputs.has('check_ledger_freshness')).toBe(true);
  });

  it('finds home_domain_check_enabled in action.yml', () => {
    expect(actionInputs.has('home_domain_check_enabled')).toBe(true);
  });

  // ── 3. Every action.yml input appears in the schema ───────────────────────

  it('every action.yml input has a matching schema property', () => {
    const missing = findInputsMissingFromSchema(actionInputs, schema.properties);
    expect(missing).toEqual([]);
  });

  // ── 4. No schema properties are orphaned (not in action.yml) ─────────────

  it('every schema property maps to an action.yml input', () => {
    const orphaned = findSchemaPropertiesNotInAction(actionInputs, schema.properties);
    expect(orphaned).toEqual([]);
  });

  // ── 5. required[] alignment ───────────────────────────────────────────────

  it('every action.yml required:true input appears in schema required[]', () => {
    const schemaRequired = schema.required ?? [];
    const missing = findRequiredInputsMissingFromSchemaRequired(actionInputs, schemaRequired);
    expect(missing).toEqual([]);
  });

  it('no schema required[] entry is optional in action.yml', () => {
    const schemaRequired = schema.required ?? [];
    const wronglyRequired = findSchemaRequiredNotRequiredInAction(actionInputs, schemaRequired);
    expect(wronglyRequired).toEqual([]);
  });

  // ── 6. All schema properties have type: "string" ─────────────────────────
  //
  // GitHub Actions passes ALL inputs as strings at runtime regardless of
  // their logical meaning. The schema should reflect this so integrator
  // tooling does not reject numeric/boolean literal values.

  it('all schema properties have type: "string"', () => {
    const nonString = Object.entries(schema.properties)
      .filter(([, prop]) => (prop as { type: string }).type !== 'string')
      .map(([name]) => name);
    expect(nonString).toEqual([]);
  });

  // ── 7. Well-known inputs have correct defaults ────────────────────────────

  it('github_token has no default (required input)', () => {
    const prop = schema.properties['github_token'] as { default?: string };
    expect(prop.default).toBeUndefined();
  });

  it('fail_on_missing default is "true"', () => {
    const prop = schema.properties['fail_on_missing'] as { default?: string };
    expect(prop.default).toBe('true');
  });

  it('horizon_url default is "https://horizon.stellar.org"', () => {
    const prop = schema.properties['horizon_url'] as { default?: string };
    expect(prop.default).toBe('https://horizon.stellar.org');
  });

  it('check_ledger_freshness default is "false"', () => {
    const prop = schema.properties['check_ledger_freshness'] as { default?: string };
    expect(prop.default).toBe('false');
  });

  it('home_domain_check_mode default is "warn"', () => {
    const prop = schema.properties['home_domain_check_mode'] as { default?: string };
    expect(prop.default).toBe('warn');
  });

  it('max_ledger_lag_seconds default is "60"', () => {
    const prop = schema.properties['max_ledger_lag_seconds'] as { default?: string };
    expect(prop.default).toBe('60');
  });

  // ── 8. Intentional mismatch detection ────────────────────────────────────
  //
  // These tests simulate a developer adding an input to action.yml without
  // updating the schema, or vice-versa, and verify the helpers catch it.

  describe('mismatch detection — helpers catch drift correctly', () => {

    it('detects an input in action.yml missing from schema', () => {
      const fakeInputs = new Map(actionInputs);
      fakeInputs.set('new_undocumented_input', { required: false });

      const missing = findInputsMissingFromSchema(fakeInputs, schema.properties);
      expect(missing).toContain('new_undocumented_input');
    });

    it('detects a schema property with no matching action.yml input', () => {
      const fakeProperties = {
        ...schema.properties,
        orphaned_schema_property: { type: 'string', description: 'stale' },
      };

      const orphaned = findSchemaPropertiesNotInAction(actionInputs, fakeProperties);
      expect(orphaned).toContain('orphaned_schema_property');
    });

    it('detects a required:true input missing from schema required[]', () => {
      const missing = findRequiredInputsMissingFromSchemaRequired(
        actionInputs,
        [], // empty schema required — github_token should be flagged
      );
      expect(missing).toContain('github_token');
    });

    it('detects a schema required[] entry that is optional in action.yml', () => {
      const wronglyRequired = findSchemaRequiredNotRequiredInAction(
        actionInputs,
        ['fail_on_missing'], // fail_on_missing is required:false in action.yml
      );
      expect(wronglyRequired).toContain('fail_on_missing');
    });

    it('detects multiple simultaneous drifts', () => {
      const fakeInputs = new Map(actionInputs);
      fakeInputs.set('input_a', { required: false });
      fakeInputs.set('input_b', { required: true });

      const fakeProperties = { ...schema.properties };
      // input_a and input_b are missing from schema
      const missingFromSchema = findInputsMissingFromSchema(fakeInputs, fakeProperties);
      expect(missingFromSchema).toContain('input_a');
      expect(missingFromSchema).toContain('input_b');
    });

    it('does NOT flag an input that is present in both action.yml and schema', () => {
      const missing = findInputsMissingFromSchema(actionInputs, schema.properties);
      expect(missing).not.toContain('github_token');
      expect(missing).not.toContain('horizon_url');
      expect(missing).not.toContain('check_ledger_freshness');
    });

  });

  // ── 9. Schema $id and $schema meta fields ────────────────────────────────

  it('schema has a $schema field pointing to JSON Schema draft-07', () => {
    const raw = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as { $schema?: string };
    expect(raw.$schema).toBe('http://json-schema.org/draft-07/schema#');
  });

  it('schema has a $id field', () => {
    const raw = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as { $id?: string };
    expect(typeof raw.$id).toBe('string');
    expect(raw.$id!.length).toBeGreaterThan(0);
  });

  // ── 10. Count parity ─────────────────────────────────────────────────────

  it('schema property count matches action.yml input count', () => {
    const actionCount = actionInputs.size;
    const schemaCount = Object.keys(schema.properties).length;
    expect(schemaCount).toBe(actionCount);
  });

});
