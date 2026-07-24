# Changelog

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
