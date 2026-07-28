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
export declare function buildSarifRules(): SarifRule[];
/**
 * Map a TrustBridge check result to a SARIF result level.
 */
export declare function checkToSarifLevel(check: CheckResultItem): SarifLevel;
/**
 * Map a TrustBridge check label to a SARIF rule ID.
 */
export declare function checkLabelToRuleId(label: string): string;
/**
 * Build a single SARIF result from a TrustBridge check.
 */
export declare function checkToSarifResult(check: CheckResultItem, assetCode: string, horizonUrl: string, stellarAddress: string): Record<string, unknown>;
/**
 * Build a complete SARIF 2.1.0 output from a TrustBridge ValidationResult.
 * Returns a valid SARIF object ready for serialization to JSON and upload
 * to GitHub Advanced Security via the upload-sarif action.
 */
export declare function buildSarifOutput(result: ValidationResult, assetCode: string, horizonUrl: string, stellarAddress: string, version?: string): Record<string, unknown>;
/**
 * Serialize SARIF output to a JSON string.
 * Safe for writing to a file or environment variable.
 */
export declare function serializeSarif(sarif: Record<string, unknown>): string;
/**
 * Validate that a SARIF output matches the 2.1.0 schema essentials.
 * Returns true if the structure is valid, false otherwise.
 */
export declare function validateSarifSchema(sarif: unknown): boolean;
