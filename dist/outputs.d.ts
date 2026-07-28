import { ValidationResult, CheckConfig } from './checks';
export interface ActionOutputs {
    trustline_exists: string;
    xlm_balance: string;
    account_funded: string;
    comment_url: string;
    /** JSON array of per-asset trustline statuses when assets_json is used. */
    assets_trustline_status: string;
    /** "true" if all assets in assets_json have trustlines, "false" otherwise, "" when not used. */
    trustlines_summary: string;
}
export declare function toActionOutputs(result: ValidationResult, commentUrl?: string): ActionOutputs;
export declare function setValidationOutputs(result: ValidationResult, commentUrl?: string): void;
export declare function writeValidationJson(result: ValidationResult, config: CheckConfig & {
    stellarAddress: string;
}, outputPath: string): void;
