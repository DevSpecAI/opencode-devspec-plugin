/**
 * OpenCode native control slashes for DevSpec remote control (item b315fe42).
 *
 * Exact owner tokens only — `/compact`, `/summarize`, `/abort`, `/new`, `/clear`,
 * `/undo`, `/redo` — executed via `@opencode-ai/sdk` session APIs, never
 * `promptAsync` of the slash text.
 */
export declare const OPENCODE_CONTROL_SLASH_NAMES: readonly ["compact", "summarize", "abort", "new", "clear", "undo", "redo"];
export type OpencodeControlSlashName = (typeof OPENCODE_CONTROL_SLASH_NAMES)[number];
export type OpencodeControlSlash = {
    kind: 'compact';
} | {
    kind: 'abort';
} | {
    kind: 'new';
} | {
    kind: 'undo';
} | {
    kind: 'redo';
};
/**
 * Parse a single owner-command body as an exact OpenCode control slash.
 * Extra prose or arguments → null (falls through to normal prompt inject).
 */
export declare function parseOpencodeControlSlash(raw: string | null | undefined): OpencodeControlSlash | null;
/**
 * When the delivered turn is exactly one control slash (no attachments),
 * return it — otherwise null so the normal promptAsync path runs.
 */
export declare function resolveOwnerControlSlash(commands: unknown[]): OpencodeControlSlash | null;
export declare function controlSlashSuccessMessage(cmd: OpencodeControlSlash): string;
