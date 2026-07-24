# Changelog

## 0.2.2 - 2026-07-24

### Remote control — never mirror the terminal-only status block

- Baseline correlation (0.2.0/0.2.1) only decides *which* assistant message is new after an owner inject — it has no opinion on *what* the message says. Live-tested: `devspec.remote`'s "print this in the terminal only" instruction has nowhere to go in OpenCode (every assistant turn is both shown locally and picked up by the mirror), so the model's own connect-confirmation block was faithfully mirrored into a shared session as if it were a reply.
- Added `isOperationalChrome` / `stripRemoteControlBanner` / `prepareMirrorText` (ported from claude-code-devspec-autopilot's `mirror-turn.mjs`) — `mirrorLatestReply` now strips a pasted status block from an otherwise-real answer, and skips posting entirely when nothing postable remains.

## 0.2.1 - 2026-07-24

### Remote control — strict baseline fail-closed

- Track `replyBaselineCaptured` separately from the baseline message id.
- If the pre-inject assistant snapshot **fails**, mirror **fail-closes** (no post of newest-in-history).
- Empty history at inject (snapshot ok, null baseline) still allows the next assistant as the reply.

## 0.2.0 - 2026-07-24

### Remote control — agent-canonical, connection-scoped, session optional

- **Posts** use `post_session_message({ connection_id, turn_kind: "agent" })` when attached (reattach-safe).
- **Correlation:** after injecting an owner command, only mirror assistants newer than the pre-inject baseline — do not re-post an unrelated older local answer.
- **Sessionless:** no chat posts (assignment / `report_progress` only).
- **`devspec.work --remote`:** connection-native sessionless path (no invent room); optional `--session` attach.

## 0.1.0

- Initial OpenCode plugin: MCP, commands, in-process remote-control poll via `session.idle`.
