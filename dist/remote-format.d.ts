/**
 * Remote-control formatting and sequencing helpers.
 *
 * This module used to decide whether a turn was postable by reading it: banner
 * matching, status-field counting, "internal note" stripping, an
 * `isOperationalChrome` classifier and a `prepareMirrorText` that returned
 * null for anything it judged to be machinery. Each rule was added after a live
 * failure, and the last of them let the word "Done." through into DevSpec
 * session 8fd18ec0 on 2026-08-17 because it did not look like chrome.
 *
 * Answer egress is model-owned now, so there is nothing left to classify. What
 * survives here is generic markdown formatting plus command-name and inject
 * sequencing checks used outside answer delivery.
 */
export declare function unwrapSingleOuterMarkdownFence(text: string): string;
/** Drop orphan fence markers left after a banner strip (e.g. ```\\n```). */
export declare function collapseOrphanMarkdownFences(text: string): string;
/** Slash commands whose assistant turn is the plugin's own protocol, not an answer. */
export declare const DEVSPEC_REMOTE_CONTROL_COMMANDS: Set<string>;
/** True for `/devspec.remote` and `/devspec.remote-stop` (OpenCode command.executed name). */
export declare function isDevspecRemoteControlCommand(name: unknown): boolean;
export declare const CONNECT_HANDSHAKE_TIMEOUT_MS = 15000;
/**
 * Defer an owner-command inject while a connect handshake is still settling.
 *
 * Session bf7acd8c / item 6990fd9e: a dispatch landed mid-`/devspec.remote`
 * (register done, attach not finished), was injected into that connect turn,
 * and the handshake never completed cleanly. This is about SEQUENCING a turn,
 * not about judging any text.
 *
 * `connectHandshakePending` means the handshake is still settling.
 * A timeout guard (CONNECT_HANDSHAKE_TIMEOUT_MS) and idle check ensure an
 * un-cleared handshake flag does not block subsequent command pickups indefinitely.
 *
 * This helper only handles connect sequencing. `shouldDeferCanonicalPrompt`
 * separately serializes follow-up prompts while an answer is outstanding.
 */
export declare function shouldDeferInjectDuringConnect(opts: {
    connectHandshakePending?: boolean | null;
    connectHandshakeStartedAt?: number | null;
    awaitingRemoteReply?: boolean | null;
    busy?: boolean | null;
    now?: number;
}): boolean;
