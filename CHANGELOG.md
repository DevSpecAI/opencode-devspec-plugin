# Changelog

## Unreleased

### Remote control — full session UUID for transcript + broader status chrome strip

Live (OpenCode · Dashing Osprey / session `7976fffb`): `/devspec.remote --session <short>` attached fine, then `get_session_transcript` with the same short code failed ("Session not found"). Separately, a variant status block (box-drawing rule without the exact `━━━ DevSpec Remote Control ━━━` title) plus an `Internal note (not mirrored)` orientation paragraph was mirrored into the DevSpec room.

- Skill (`commands/devspec.remote.md`): after `attach_connection`, always use the **returned full `session_id`** for transcript — never the CLI short code alone.
- `prepareMirrorText` / `isOperationalChrome`: strip variant Agent/Connection/Session field blocks and labelled Internal-note chrome, not only the canonical banner title.
- Tests cover the live variant sample; real answers after a pasted block still post.

Item `6d008352`.

## 0.3.5 - 2026-08-04

### Read a memory before superseding it — search now returns a card

DevSpec's `search_memories` changed today: it returns a **card** (title, one-line summary, id, state) instead of the full memory body, because a 15-result search was returning over 600,000 characters. The full text comes from a new `get_memory` tool.

- **The instruction that mattered was the supersede one.** This plugin told the agent to search memories first and supersede the closest match instead of duplicating — a judgement made against full bodies yesterday, and against one-line summaries today. It now says to `get_memory` the match and read it in full first: a card is enough to choose WHICH memory you mean, not enough to justify overwriting an entry in the team's shared decision record.
- **Where the autopilot loop treats memories as hard constraints**, it now reads the binding ones in full. A summary states the decision; the body carries the qualifications and exceptions, and a constraint obeyed without its exceptions is how an unattended loop confidently does the wrong thing.
- **No `allowed-tools:` gate here**, unlike the Claude Code plugin, so `get_memory` was already callable — this release is about the instructions, not about unblocking a refused tool call.

Nothing else needs reinstalling for the DevSpec-side change: MCP tool definitions come from the server, so a reconnect picks up the renamed `body` parameter and the now-required `title` on `record_memory`.

Item `93a851b5`.

## 0.3.3 - 2026-07-29

### Remote control — large screenshots no longer stall the turn

Live report (session `506e2926`): a ~673KB PNG inlined as a `data:` URL left OpenCode busy ~132s with no reply text (stall warning only). Hard cap was 4MB, so the image was delivered — but stuffing that much base64 into the inject payload hung the model.

- Soft inline cap **`INLINE_DATA_URL_MAX_BYTES` = 256KB**. Larger (still ≤4MB) attachments spill to `~/.devspec/opencode-remote-control/attachments/` as `file://` URLs via `materializeLargeAttachmentToDisk`.
- Without a spill host, mid-size attachments are declined out loud (never silent).
- Tests cover spill / decline / hard-cap paths.

**Requires plugin reload (0.3.3).**

## 0.3.2 - 2026-07-29

### Remote control — mechanical guard against double-posted replies

Live regression (Climbing Zebra / session `506e2926`): every substantive reply appeared twice in DevSpec ~1–2s apart. Docs (`42391f84`) already told the model not to call `post_session_message` (the plugin auto-mirrors), but the model still sometimes did — so mirror + manual post both landed.

- **Settle debounce** on `message.updated` (`scheduleMirrorNow`, 2s) so a manual `post_session_message` tool can finish and be recorded before mirroring; `session.idle` still flushes immediately.
- **`recordManualPostSessionMessage`** on `tool.execute.after` remembers a content hash of the posted body.
- **`mirrorLatestReply` skips** when that hash is present, or when the assistant message already has a `post_session_message` tool part — then claims the OpenCode message id so busy clears without a second DevSpec bubble.
- Tests: `test/mirror-dedup.test.mjs`.

**Requires a reinstall / reload** of the OpenCode plugin for the guard to take effect.

## 0.3.0 - 2026-07-25

### Remote control — long-poll delivery, and the room finally reaches the model

Two items landed in one pass over `remote-control.ts`, as they were specified to be: `c9457ab8` (long-poll) and `807eadcb` (stop discarding room context).

**The context discard is fixed.** `pollAndDeliver` read the whole room every tick and then threw almost all of it away:

```js
const toDeliver = allMessages.filter((m) => m?.remote_control?.is_owner_instruction === true)
```

…advancing the cursor past everything else. This was the **only hard discard among the six DevSpec plugins** — the others persisted advisory and merely failed to inject it. So a question like "what do you think of this?" arrived with no trace of the conversation that prompted it; in the live demo OpenCode answered from an unrelated old maths question in its own chat, because it genuinely had nothing else. The server now returns the turn already tiered, and the plugin injects **one prompt** containing the room context (owner-speaking-but-not-to-you above everyone-else, both labelled inert) followed by every command in the delta, each naming its addressee.

**The 8s interval is gone.** `POLL_INTERVAL_MS = 8000` was the shortest cadence of any DevSpec plugin — 2 of the token's 60 req/min budget every 8 seconds, per connection. It is replaced by a single `poll_connection` request the server holds open (~25s attended / 30s idle) and answers the instant anything lands: **~2 requests/minute AND lower latency**, rather than the tradeoff the original "just lower the interval to 1-2s" plan would have forced (that would have consumed the entire per-token budget from one connection).

Details worth knowing:

- **A carry buffer is required, not optional.** A long-poll returns the instant anything lands, so `1`, `2`, `3` and the question that refers to them arrive as *four separate responses*. Advisory is therefore carried forward (20 msgs / 12k chars **per tier**, oldest dropped first) and attached to the next command, with the dropped count reported to the model rather than silently hidden. Without this the regression test passes vacuously against an empty context block.
- **Mirroring is now event-driven** (`message.updated` / `session.idle`), not a side-effect of the poll tick. Hanging it off a ~25s hold would have traded delivery latency for reply latency; this is faster than the old 8s floor and costs nothing when there is no new reply.
- **`get_connection_dispatch` is no longer called separately** — assignments arrive in the same held response and are delivered through the same command path (dedup still persisted, so a plugin restart cannot re-inject an assignment).
- **`dispose` aborts an in-flight hold**, so a held request can never outlive the host process.
- A client-side ceiling (`timeoutMs`) was added to the MCP client: `fetch` has no default timeout, so a silently dropped connection would otherwise wedge the pump forever with no heartbeat — indistinguishable from "the owner sent nothing". A hold that hits the ceiling is treated as "nothing arrived", not as an error.
- The authority boundary is unchanged in effect but now **fails closed explicitly**: only a command the server addressed to this connection, with an authority the plugin recognises, can drive the model. Unknown authority kinds are rejected on purpose, so delegated dispatch must be a deliberate edit rather than a server value that quietly switches itself on.

**Requires a reinstall** — nothing changes until the plugin is reloaded. Also requires a DevSpec server with `poll_connection` (staging today; production needs migrations 471 + 472 first).

New: `src/poll-turn.ts` (pure, dependency-free decision + rendering logic) and `test/poll-turn.test.mjs` — 32 tests via `npm test`, run against the compiled `dist/` so they exercise exactly what ships. Covers the tiering, the inertness of both advisory tiers, multiple commands in one delta, the carry buffer, and the 1-2-3 regression itself.

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
