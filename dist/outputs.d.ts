import { ValidationResult } from './checks';
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
