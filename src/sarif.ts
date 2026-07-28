/**
 * SARIF (Static Analysis Results Interchange Format) 2.1.0 output generation.
 *
 * Emits TrustBridge validation results as SARIF for integration with GitHub
 * Advanced Security (GHAS) code scanning so wallet-check failures appear
 * alongside other security findings.
 *
 * SARIF reference: https://sarifweb.azurewebsites.net/
 */

import { ValidationResult, CheckResultItem } from './checks';

/**
 * SARIF 2.1.0 rule definition for a TrustBridge check.
 */
export interface SarifRule {
  id: string;
  shortDescription: {
    text: string;
  };
  fullDescription?: {
    text: string;
  };
  helpUri?: string;
  properties?: {
    tags?: string[];
    precision?: string;
  };
}

/**
 * SARIF result level mapping from TrustBridge check outcome.
 */
export type SarifLevel = 'note' | 'warning' | 'error';

/**
 * Build SARIF rule definitions from TrustBridge checks.
 * Each check becomes a rule with a stable ID, description, and help URI.
 */
export function buildSarifRules(): SarifRule[] {
  return [
    {
      id: 'TB001',
      shortDescription: {
        text: 'Stellar account is funded and active on the network',
      },
      fullDescription: {
        text: 'Account must exist and be activated on the Stellar network before it can hold trustlines and balances.',
      },
      helpUri: 'https://developers.stellar.org/docs/fundamentals-and-concepts/stellar-data-structures/accounts',
      properties: {
        tags: ['trustbridge', 'stellar', 'wallet-readiness'],
        precision: 'high',
      },
    },
    {
      id: 'TB002',
      shortDescription: {
        text: 'Account has a trustline for the required asset',
      },
      fullDescription: {
        text: 'The account must explicitly trust the asset issuer before it can receive the asset.',
      },
      helpUri: 'https://developers.stellar.org/docs/fundamentals-and-concepts/stellar-data-structures/account-data#trustlines',
      properties: {
        tags: ['trustbridge', 'stellar', 'wallet-readiness'],
        precision: 'high',
      },
    },
    {
      id: 'TB003',
      shortDescription: {
        text: 'Account meets minimum XLM reserve requirement',
      },
      fullDescription: {
        text: 'The account must maintain a minimum XLM balance to keep the account open and pay transaction fees.',
      },
      helpUri: 'https://developers.stellar.org/docs/learn/fundamentals/fees-and-metering#reserve',
      properties: {
        tags: ['trustbridge', 'stellar', 'wallet-readiness'],
        precision: 'high',
      },
    },
    {
      id: 'TB004',
      shortDescription: {
        text: 'Horizon API is accessible and responding',
      },
      fullDescription: {
        text: 'TrustBridge must be able to reach the configured Horizon API endpoint to verify account state.',
      },
      helpUri: 'https://developers.stellar.org/docs/data/apis/horizon',
      properties: {
        tags: ['trustbridge', 'stellar', 'infrastructure'],
        precision: 'high',
      },
    },
  ];
}

/**
 * Map a TrustBridge check result to a SARIF result level.
 */
export function checkToSarifLevel(check: CheckResultItem): SarifLevel {
  return check.passed ? 'note' : 'error';
}

/**
 * Map a TrustBridge check label to a SARIF rule ID.
 */
export function checkLabelToRuleId(label: string): string {
  if (label.includes('Account funded')) return 'TB001';
  if (label.includes('trustline')) return 'TB002';
  if (label.includes('XLM reserve')) return 'TB003';
  if (label.includes('Horizon availability')) return 'TB004';
  return 'TB000'; // Unknown
}

/**
 * Build a single SARIF result from a TrustBridge check.
 */
export function checkToSarifResult(
  check: CheckResultItem,
  assetCode: string,
  horizonUrl: string,
  stellarAddress: string,
): Record<string, unknown> {
  const ruleId = checkLabelToRuleId(check.label);
  const level = checkToSarifLevel(check);

  return {
    ruleId,
    level,
    message: {
      text: check.detail,
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: horizonUrl,
            description: {
              text: `Stellar Horizon endpoint for account ${stellarAddress}`,
            },
          },
        },
      },
    ],
    properties: {
      assetCode,
      checkLabel: check.label,
      passed: check.passed,
    },
  };
}

/**
 * Build a complete SARIF 2.1.0 output from a TrustBridge ValidationResult.
 * Returns a valid SARIF object ready for serialization to JSON and upload
 * to GitHub Advanced Security via the upload-sarif action.
 */
export function buildSarifOutput(
  result: ValidationResult,
  assetCode: string,
  horizonUrl: string,
  stellarAddress: string,
  version: string = '1.0.0',
): Record<string, unknown> {
  const rules = buildSarifRules();
  const sarif = {
    version: '2.1.0',
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'TrustBridge Action',
            version,
            informationUri: 'https://github.com/Stellar-TrustBridge/trustbridge-action',
            semanticVersion: version,
            rules,
          },
        },
        results: result.checks.map((check) =>
          checkToSarifResult(check, assetCode, horizonUrl, stellarAddress),
        ),
        properties: {
          trustbridgeVersion: version,
          runTimestamp: new Date().toISOString(),
          validationGate: {
            ready: result.valid,
            totalChecks: result.checks.length,
            passedChecks: result.checks.filter((c) => c.passed).length,
            failedChecks: result.checks.filter((c) => !c.passed).length,
          },
        },
      },
    ],
  };

  return sarif;
}

/**
 * Serialize SARIF output to a JSON string.
 * Safe for writing to a file or environment variable.
 */
export function serializeSarif(sarif: Record<string, unknown>): string {
  return JSON.stringify(sarif, null, 2);
}

/**
 * Validate that a SARIF output matches the 2.1.0 schema essentials.
 * Returns true if the structure is valid, false otherwise.
 */
export function validateSarifSchema(sarif: unknown): boolean {
  if (!sarif || typeof sarif !== 'object') return false;
  const s = sarif as Record<string, unknown>;
  if (s.version !== '2.1.0') return false;
  if (!Array.isArray(s.runs) || s.runs.length === 0) return false;

  const run = s.runs[0] as Record<string, unknown>;
  if (!run.tool || !run.tool || typeof run.tool !== 'object') return false;
  const tool = run.tool as Record<string, unknown>;
  if (!tool.driver) return false;
  if (!Array.isArray(run.results)) return false;

  return true;
}
