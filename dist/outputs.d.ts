import { ValidationResult } from './checks';
import { ValidationArtifact, ValidationDelta } from './delta';
export interface ActionOutputs {
    trustline_exists: string;
    xlm_balance: string;
    account_funded: string;
    comment_url: string;
    readiness_badge_markdown: string;
    readiness_badge_url: string;
    num_sponsoring: string;
    num_sponsored: string;
}
export declare function toActionOutputs(result: ValidationResult, commentUrl?: string): ActionOutputs;
export declare function setValidationOutputs(result: ValidationResult, commentUrl?: string): void;
export interface WriteValidationJsonOptions {
    result: ValidationResult;
    stellarAddress: string;
    assetCode: string;
    assetIssuer: string;
    horizonUrl?: string;
    outputPath: string;
    delta?: ValidationDelta | null;
    privacyMode?: boolean;
    workspaceRoot?: string;
}
/**
 * Write a structured `validation.json` artifact for security review and
 * cross-run delta comparison. Never includes `github_token` or auth headers.
 */
export declare function writeValidationJson(options: WriteValidationJsonOptions): ValidationArtifact;
