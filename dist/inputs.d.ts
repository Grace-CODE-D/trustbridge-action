export declare function parseBooleanInput(value: string, defaultValue: boolean): boolean;
export declare function parseNumberInput(value: string, defaultValue: number, options?: {
    min?: number;
    max?: number;
}): number;
export declare function getErrorMessage(error: unknown): string;
/**
 * Maintainer-provided roster: GitHub username (assignee login) → Stellar G-address.
 * Keys are stored lowercased for case-insensitive GitHub username matching.
 */
export type AssigneeAddressMap = Record<string, string>;
export interface ParseAssigneeAddressMapOptions {
    /** Workspace root used when `raw` is a relative file path. Defaults to cwd. */
    workspaceRoot?: string;
}
/**
 * Parse `assignee_address_map` from either inline JSON or a path to a JSON file.
 *
 * Inline JSON must start with `{`. Anything else is treated as a file path
 * relative to `workspaceRoot` (or absolute).
 */
export declare function parseAssigneeAddressMap(raw: string, options?: ParseAssigneeAddressMapOptions): AssigneeAddressMap;
/**
 * Look up a Stellar address for an assignee login in a parsed roster map.
 * Throws an actionable error when the login is missing or not in the map.
 */
export declare function resolveAddressFromAssigneeMap(map: AssigneeAddressMap, assigneeLogin: string | undefined | null): string;
