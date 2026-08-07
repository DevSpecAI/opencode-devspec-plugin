# Remote control — OpenCode (LLM primer)

**Family:** native runtime (not local-poller).  
**Read first:** `docs/remote-control/remote-control-overview.md`.  
**Plugin repo:** `opencode-devspec-plugin` (`src/remote-control.ts`, `src/poll-turn.ts`, `src/mirror-chrome.ts`).

## Local serve password (rocket launches)

Cursor’s cold-launch path (`cursor-devspec-plugin` → `launch-opencode-session.mjs`) starts a headless `opencode serve` on localhost, then attaches with `opencode run --attach`. That local HTTP door is **not** DevSpec auth.

- **DevSpec long-poll / MCP** uses the DevSpec MCP token. It never needs or receives `OPENCODE_SERVER_PASSWORD`.
- **Rocket launches** mint a one-time `OPENCODE_SERVER_PASSWORD` per serve process (or reuse one already set in the environment). The same secret is passed only to the serve child and the attach client via env. It is not written into the prompt file, launcher logs, or DevSpec.
- **Interactive terminal** (`opencode` TUI + `/devspec.remote`): the plugin talks to OpenCode in-process. Remote control still works without DevSpec knowing a serve password. Hardening interactive starts is a separate follow-up; rockets are what depend on attach-over-HTTP.

Do not “fix” an unsecured-server warning by putting a password into project settings or uploading it to DevSpec.

## How a message reaches OpenCode

1. Owner dispatches to this connection in DevSpec.
2. Plugin (inside the OpenCode process) calls held `poll_connection`.
3. On deliverable commands, plugin builds a turn via `renderInjectedTurn` (context labelled advisory; commands last).
4. Plugin calls `client.session.promptAsync` with `parts: [{ type: 'text', text }, …]` — **chat-message door**, not slash-command door.
5. OpenCode model runs a normal turn in that session.
6. Plugin mirrors the latest assistant reply via `prepareMirrorText` then `post_session_message` (chrome stripped; dedup against model-initiated posts). **Exception:** the `/devspec.remote` / `/devspec.remote-stop` skill turn itself is never mirrored (`shouldSkipConnectTurnMirror` / `command.executed` message id) — that turn is terminal-only status.
7. Activity: pickup / keepalive / complete around the injected turn.

There is **no** separate inbox wait process and **no** “re-arm the wait” step.

## Two input doors (critical)

| Door | Path | `/clear` behaviour |
|---|---|---|
| Keyboard / TUI | OpenCode command layer | Real slash command may run |
| `session.promptAsync` text parts | Model prompt | Sees the characters as prose — does **not** execute host clear |

OpenCode SDK also documents `session.command` and session create/delete. Those are how you would remotely run command-like or “fresh context” operations **if productised later**. Today’s remote path uses **prompt only**.

## Why this family exists

OpenCode exposes an in-process session API. Poller+wait is a workaround for hosts that cannot push into their own chat. Do not force OpenCode onto Claude’s scripts; do not assume other hosts can `promptAsync`.

## What not to change lightly

- Full `writeState({ ...stale })` that clobbers mirror claims → **double bubbles** (live regression).
- Injecting slash-looking text expecting host commands.
- Dropping mirror dedup while also letting the model `post_session_message`.
- Reintroducing a detached wait “for consistency” with Claude.
- Weakening fence-aware chrome filtering in `mirror-chrome.ts` (`prepareMirrorText` / `isOperationalChrome`) — models wrap the connect banner in markdown fences because the skill shows it that way.
- Letting empty / chrome-only `external_agent` rows settle commands in `unansweredCommands` — that permanently suppresses a still-unanswered owner dispatch.
- Returning early on `adopt.changed` without a follow-up null-cursor seed — fixed by always re-polling with `cursor:null` + `catch_up` after adopt (session `23da0643` / item `2411dd5a`). Do **not** fall through and consume the pre-adopt package: it was opened under the previous room's cursor, and advisory-only advance permanently skips a cold-launch dispatch that lands moments later (often with a backdated paint timestamp).
- Advancing the message cursor (in-memory `pump.cursor` **or** persisted `lastDeliveredMessageId`) when deliverable commands were present but not injected — the next poll’s `cursor` arg permanently skips them (`shouldAdvanceMessageCursor`).
- Cold-launch paint timestamp reused as server `created_at` for `local_agent_dispatch` — wire order must be insertion time (DevSpecV2 chat route); optimistic UI may keep paint time locally.
- Mirroring the `/devspec.remote` connect turn (or NLP-guessing its narration as chrome) — connect skill replies are terminal-only; skipping them is by `command.executed` message id + handshake suppress (`shouldSkipConnectTurnMirror`), not by widening `isOperationalChrome`.

## Failure modes

- Double reply: mirror + model both post the same answer.
- Stall: busy with **no observable progress** for the stall timeout (empty reply text *and* no new assistant step *and* no in-flight tool). Active tool loops slide the timer — text-only emptiness is not enough to stall (Tembo / Racing Heron false positives). See `decideBusyStall` / `checkBusyStall` and `poll.log`.
- State lost-update between idle handler and mirror path.
- Fenced status banner → empty markdown-fence leftover posted as a blank bubble → seed-window treats it as a reply and settles a prior owner command (session `0ffe97cb`; fixed in `d9711ed` via fence-aware strip + chrome-aware `unansweredCommands`).
- Connect + attach lands, status banner prints, owner command never injects: pre-adopt package consumed as seed / cursor advanced past unanswered commands (sessions `1383cbb8`, `23da0643`). **Guard:** after `adopt.changed`, always re-poll with `cursor:null` + `catch_up` (`adoptRequiresNullCursorRepoll`); never fall through. Server: do not backdate `local_agent_dispatch` `created_at` to the optimistic paint time; honour `catch_up` in packaging.
- **Connect turn mirrored as a reply during a mid-attach dispatch** (session `e7ecc1de`): `/devspec.remote` prints terminal-only status plus process narration ("Oriented… Holding for long-poll…"). Banner strip leaves the narration; the mirror posts it; `unansweredCommands` treats it as the answer and drops the pending owner command from the seed inject. **Guard:** never mirror the connect skill turn — `command.executed` for `devspec.remote` / `devspec.remote-stop` records the assistant `messageID` in `nonMirrorMessageIds`, and register / first-attach sets `connectMirrorSuppressed` so a `flushMirrorNow` that races ahead of that event still skips. Cleared after the skip (or when awaiting a real inject reply). Do **not** NLP-widen chrome for "oriented/holding" prose; do **not** weaken the seed filter.
- **Late `command.executed` poisons the inject answer** (session `8a97effc` / connection `4aab7fe0`): OpenCode fires `devspec.remote` `command.executed` *after* inject against the answer message id. That id lands in `nonMirrorMessageIds`; mirror skips with `connect_turn_suppress` while `awaitingRemoteReply` is true, claims `lastMirrored`, and later polls say "already mirrored" — reply stays in the terminal only. **Guard:** `awaitingRemoteReply` wins — `shouldSkipConnectTurnMirror` never skips while awaiting; `recordRemoteControlSkillCommand` ignores `command.executed` while awaiting so the answer id is never recorded. Do **not** weaken `isOperationalChrome` / `prepareMirrorText` to paper over this.
- **Sibling agent reply settles OpenCode's unanswered dispatch** (session `5546c769` / command `c117ffae`): after OpenCode fails to mirror, Cursor posts in the same room; on OpenCode reconnect `unansweredCommands` treats that Cursor bubble as the answer and seed_filter drops the still-unanswered OpenCode dispatch (`already_answered`). **Guard:** pass `AGENT_NAME` + `connectionId` into `unansweredCommands` so only THIS agent's `external_agent` rows settle.

## Key files

- `src/remote-control.ts` — poll loop, inject, mirror, busy; `recordRemoteControlSkillCommand`
- `src/poll-turn.ts` — pure command gate + `renderInjectedTurn` + `unansweredCommands` + `shouldAdvanceMessageCursor`
- `src/mirror-chrome.ts` — fence-aware status strip / `prepareMirrorText` / `shouldSkipConnectTurnMirror` (shared by mirror + seed-window filtering)
- `src/plugin.ts` — long-poll pump + `command.executed` → skip-mirror ids
- `src/agent-identity.ts` — `AGENT_NAME = 'OpenCode'`
- `commands/devspec.remote.md`
- `~/.devspec/opencode-remote-control/poll.log` — local diagnostics (human lines + structured `story {…}` JSON)

## Logging — reconstructing a connection story

Fragile remote sessions are debugged from two places that share one phase vocabulary:

| Source | Where | What |
|---|---|---|
| **Axiom (server)** | DevSpec MCP tool logs | `msg == "Remote-control story"` with `connectionId`, `sessionId`, `data.phase`, `data.outcome`, `reason` |
| **Local poll.log** | `~/.devspec/opencode-remote-control/poll.log` | Same phases as JSON lines prefixed `story ` (plus human `logPoll` lines). Kept for offline debug when Axiom is empty. |

**Shared phases:** `register` · `attach` · `seed_filter` · `inject` · `wake` · `mirror_decision` · `mirror_post` · `complete_turn` · `pickup` · `done` · `poll_error` · `stall` · `ended`

OpenCode emits client-side stories at seed filter, inject, advisory wake, mirror skip/post, poll errors, and stall timeout. The server emits the same vocabulary from MCP tools after staging deploy of the breadcrumbs change.

**Axiom recipe** (dataset `devspec`):

```
['devspec']
| where msg == "Remote-control story"
| where connectionId == "<connection-uuid>"
| sort by _time asc
| project _time, ['data.phase'], ['data.outcome'], reason, sessionId, ['data.agent'], ['data.tool']
```

**Local recipe:** open `poll.log` and grep `story ` for the same connectionId. Do not dump model token streams into either log.
