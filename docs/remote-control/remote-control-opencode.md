# Remote control — OpenCode (LLM primer)

**Audience:** coding agents changing OpenCode remote-control behaviour.  
**Family:** native runtime (not local-poller).  
**Read first:** `docs/remote-control/remote-control-overview.md`.  
**Plugin repo:** `opencode-devspec-plugin`.

## Agent gotchas (read before editing)

1. **Presence is the bond.** Server attached liveness is ~90s. `last_seen` updates only when a `poll_connection` (or equivalent heartbeat) succeeds — **not** when `report_keepalive` runs alone. Anything that blocks the next successful poll for ~90s ends the connection with `idle_timeout` while the UI can still look attached.
2. **OpenCode’s pump is in-process** (`src/plugin.ts` → `pollAndDeliver`). It negotiates canonical ingress using `ingress_version: 1`; the mutable wire and authority policy lives at `devspec://product/remote-ingress-contract`. Cursor keeps a **detached** Node poller. Do not “fix” OpenCode by copying Cursor’s wait/inbox scripts, and do not await inject / stall / hung `session.messages` on the path back to `poll_connection`.
3. **Multi-bond in one process** (item 7a9b7b0f): several OpenCode chat sessions may each `/devspec.remote` into different DevSpec rooms. The pump iterates `listOpenCodeBondSessions()` — a second attach **adds** a bond; it must **not** overwrite a single `lastKnownSessionId` (that starved Ivory Panda when Racing Dolphin attached, 2026-08-07 → first room `idle_timeout`). Ending one bond removes only that entry. State reads/writes for each bond run under `runWithBoundSession(stateKey)`.
4. **Critical path after claiming delivery:** `setBusy(true)` then fire-and-forget `deliverInjectedTurn` (baseline → `promptAsync` → mirror), ALS-scoped to the inject bond. Return `{ delayMs: 0 }` so the pump re-enters the hold immediately. `checkBusyStall` is also `void`’d, not awaited.
5. **After changing `dist/`:** fully quit and relaunch OpenCode (or reinstall the local package). Partial reloads leave a stale pump in memory.
6. **Verify with** `npm test` from the plugin root (see [Running tests](#running-tests-after-a-remote-control-change)). Unit suite uses harness doubles — it does not launch a live TUI bond.
7. **Act, don’t dump.** `commands/devspec.remote.md` must keep an **Act on owner commands** section (do the work in this repo / verify with tools) — parity with Cursor/Claude. Do not reintroduce “you do not need to go and read anything” / “grounded in the transcript” wording that licenses answering from the injected dump alone (Obsidian Gecko / Restless Ocelot, session `a2a262cd`).
8. **Attach transcript is budgeted + full UUID.** Skill attach uses `get_session_transcript` with `since_created_at` (~48h window), not an uncapped seed. Instruction tiers come from `attach_connection`. **Always pass the full `session_id` returned by `attach_connection`** — attach accepts an 8-char short code; transcript does not (live: Dashing Osprey / `7976fffb` → "Session not found"). Do not tell the model to call uncapped `get_session_transcript` on every attach.
9. **Connect status chrome must never land in the room.** `prepareMirrorText` / `isOperationalChrome` strip the canonical `REMOTE_STATUS_BANNER` **and** variant field blocks (rule-only openers + Agent/Connection/Session lines) plus labelled `Internal note (not mirrored)` orientation. Do not rely on exact title string alone — models invent box-drawing variants. Real answers after a pasted block still post once chrome is stripped.
10. **Model stamp is never silent.** `resolveOpenCodeAssistantModel` (flat `info.providerID`/`modelID` first, then nested `info.model`, then legacy `metadata.assistant`) + `mirror_post`/`model_missing` (and inject `dispatch_model` rejects via `extractOpenCodeReplyModel`) must log a story with the raw shape snippet when `providerID`/`modelID` cannot be stamped — DevSpec otherwise has no record of which model answered. Assistant turns (e.g. MiniMax) store the stamp flat on `info`; reading only nested `info.model` falsely logs `model_missing`.

## Architecture (how it works today)

```
OpenCode process
  plugin.ts  ──self-scheduling multi-bond loop──►  for each openCodeBond:
                                                    runWithBoundSession(stateKey) →
                                                      pollAndDeliver (remote-control.ts)
                                                            │
                                                            ├─ busy? report_keepalive + void checkBusyStall
                                                            ├─ maybeWarnPresenceGap
                                                            ├─ held poll_connection (25s attended / 30s idle + 15s HTTP grace)
                                                            ├─ canonical conversation → its own render/inject acceptance transaction
                                                            ├─ explicit playbook → independent render/inject acceptance transaction
                                                            │                        ├─ session.messages (5s timeout) baseline
                                                            │                        ├─ session.promptAsync acceptance → commit independent cursors/ids
                                                            │                        └─ mirror → post_session_message
                                                            ├─ canonical typed control → deterministic SDK action → control_ack
                                                            └─ delayMs 0 → next bond / loop again (hold IS the wait)
```

There is **no** separate inbox wait process and **no** “re-arm the wait” step (unlike Claude/Cursor local-poller family). One process may keep **multiple** DevSpec bonds alive concurrently (one OpenCode chat session per bond).

### Holds and presence constants (`poll-turn.ts` / `remote-control.ts`)

| Constant | Value | Role |
|---|---|---|
| `ATTENDED_HOLD_MS` | 25s | Server hold when attached or mid-turn |
| `IDLE_HOLD_MS` | 30s | Server hold when sessionless / idle |
| `HOLD_HTTP_GRACE_MS` | 15s | Client fetch ceiling on top of hold |
| Server idle window | ~90s | Bond ends → `end_reason: idle_timeout` |
| `PRESENCE_GAP_WARN_MS` | 60s | Client story `presence_gap` before server idle |
| `PRESENCE_GAP_WARN_COOLDOWN_MS` | 30s | Min spacing between gap warnings |
| `OPENCODE_SESSION_API_TIMEOUT_MS` | 5s | Ceiling on `session.messages` (stall + inject baseline) |
| `MCP_SHORT_CALL_TIMEOUT_MS` | 10s | Ordinary MCP on pump path |
| `MCP_HEARTBEAT_TIMEOUT_MS` | 5s | Heartbeat / detach |
| `STALL_TIMEOUT_MS` | 120s (override `DEVSPEC_OPENCODE_STALL_MS`) | Busy with no observable progress |
| `MAX_SAME_ASSISTANT_ACTIVE_TOOL_SLIDES` | 2 | Cap keepalive slides on the same “running” tool id |
| `PERMISSION_ASK_STALL_MS` | 15s | Early stall after `permission.asked` (never slides as `active_tool`) |
| `IDLE_RECHECK_MS` (plugin) | 5s | Sleep only when **not connected** yet or after errors — not a poll cadence |

`poll_connection` heartbeats server-side at the **start** of each hold. A completed hold with nothing to deliver is normal — re-issue immediately (`delayMs: 0`). A client ceiling timeout on the hold is also normal (nothing arrived) — re-issue, do not back off as if the bond died.

### What may sit ahead of the next `poll_connection`

**Allowed (short):** `report_keepalive` while `busy`, `maybeWarnPresenceGap`, reading local state, building the next MCP args.

**Forbidden (regresses idle_timeout):** awaiting `deliverInjectedTurn`, awaiting `checkBusyStall`, awaiting unbounded `session.messages` / MCP on the pump tick. Hung MCP without a timeout was Climbing Koala / Steady Wolf; hung session API + await-inject was Gentle Weasel / Crimson Osprey (2026-08-07).

**Watch-out (off pump path today):** `mirrorLatestReply` still calls `session.messages` **without** `withTimeout`. That runs inside fire-and-forget deliver / event-driven mirror, so it should not starve the pump — but do not move an untimed `session.messages` back onto the critical path, and prefer wrapping new session-API calls with `OPENCODE_SESSION_API_TIMEOUT_MS`.

### Local state on disk

Under `~/.devspec/opencode-remote-control/`:

- `poll.log` — human lines + `story {…}` JSON
- connection state JSON (keyed by directory + bound session) — busy, cursors, mirrored ids, baselines
- `attachments/` — spilled oversize files

Do not clobber state with a full `writeState({ ...stale })` while another path patches (double bubbles / lost delivery bookkeeping). Prefer `patchState`.

## Local serve password

Cursor’s cold-launch path (`cursor-devspec-plugin` → `launch-opencode-session.mjs`) starts a headless `opencode serve` on localhost, then attaches with `opencode run --attach`. Interactive TUI (`opencode` + `/devspec.remote`) also opens that localhost HTTP door. That door is **not** DevSpec auth.

- **DevSpec long-poll / MCP** uses the DevSpec MCP token. It never needs or receives `OPENCODE_SERVER_PASSWORD`.
- **Rocket launches** mint a one-time `OPENCODE_SERVER_PASSWORD` per serve process (or reuse one already set in the environment). The same secret is passed only to the serve child and the attach client via env. It is not written into the prompt file, launcher logs, or DevSpec.
- **Interactive terminal** (`opencode` TUI + `/devspec.remote`): the DevSpec OpenCode plugin mints or reuses `OPENCODE_SERVER_PASSWORD` as soon as the plugin module loads (same mint-or-reuse rule as rockets), so the embedded server is never unsecured. The secret stays process-local; remote control still authenticates to DevSpec with the MCP token only.

Do not “fix” an unsecured-server warning by putting a password into project settings or uploading it to DevSpec.

## How a message reaches OpenCode

1. Owner dispatches to this connection in DevSpec.
2. Plugin (inside the OpenCode process) long-polls via held `poll_connection`.
3. An active canonical conversational turn and an explicit playbook run are extracted independently and each gets its own immutable `renderInjectedTurn` / acceptance transaction. Malformed conversational ingress cannot block a valid playbook.
4. Plugin asserts `setBusy(true)`, then **kicks** each `deliverInjectedTurn` without awaiting it. No corresponding cursor or delivery id commits yet.
5. Inside deliver: timed `session.messages` baseline → `client.session.promptAsync` with `parts: [{ type: 'text', text }, …]` — **chat-message door**, not slash-command door. Canonical SDK acceptance commits only turn ids and top-level `cursor_v2`; playbook acceptance commits only playbook ids and `dispatch_cursor`; `window.next_cursor` remains the older catch-up continuation.
6. OpenCode model runs a normal turn in that session.
7. Plugin mirrors the latest assistant reply via `prepareMirrorText` then `post_session_message` (chrome stripped; dedup against model-initiated posts). **Exception:** the `/devspec.remote` / `/devspec.remote-stop` skill turn itself is never mirrored (`shouldSkipConnectTurnMirror` / `command.executed` message id) — that turn is terminal-only status.
8. Activity: pickup at inject kickoff; keepalive on later polls while busy; complete when mirror clears busy / idle path.

## Two input doors (critical)

| Door | Path | `/clear` behaviour |
|---|---|---|
| Keyboard / TUI | OpenCode command layer | Real slash command may run |
| `session.promptAsync` text parts | Model prompt | Sees the characters as prose — does **not** execute host clear |

Conversational bodies always use the prompt door, even when they look like `/abort` or `/clear`. Canonical typed controls use a separate deterministic SDK path and acknowledge the server only after that host action succeeds.

## Why this family exists

OpenCode exposes an in-process session API. Poller+wait is a workaround for hosts that cannot push into their own chat. Do not force OpenCode onto Claude’s scripts; do not assume other hosts can `promptAsync`.

## Work trail / Show work (plugin-owned)

While a remote turn runs, the plugin grows a live DevSpec bubble via `post_session_message({ phase: 'trail' })`. The owner expands it under **Show work**. This is **plugin-owned**, not model `post_session_message`. The skill tells the model to emit one OpenCode sentence first when work will precede the answer (that text becomes the contentful trail); it still forbids the model calling `post_session_message` or narrating after the answer is known.

| Piece | Behaviour |
|---|---|
| Module | `src/work-trail.ts` (pure serialize) + publish helpers in `src/remote-control.ts` |
| Seed | `TRAIL_SEED_TEXT` (`Working…`) the instant the turn starts (item `05a88ed5`) so the room is not busy-dots-only while the model thinks |
| Growth | Full replace of the cumulative trail on each post (never append). Throttled (`TRAIL_POST_MIN_GAP_MS` ≈ 1s) + hash-skip identical bodies |
| Content | **Unfiltered on purpose** — tool calls, reasoning, failures, and tool output. Opposite of answer mirror chrome strip (`prepareMirrorText`). Only enormous single parts are mid-elided; total capped at `TRAIL_MAX_CHARS` (100k) |
| Close | When the answer posts with `phase: 'answer'` (+ `complete_turn` as applicable), the live trail collapses under **Show work** |

**Vs Cursor:** Cursor is local-poller — IDE mid-turn hooks and/or a **CLI transcript watcher** feed trail because Agents `--resume` often skips hooks. OpenCode already sits inside the session API, so it serializes the in-flight turn directly. Do **not** port Cursor’s wait/inbox/transcript-watcher stack into OpenCode for Show work.

## What not to change lightly

- Full `writeState({ ...stale })` that clobbers mirror claims → **double bubbles** (live regression).
- Injecting slash-looking text expecting host commands.
- Dropping mirror dedup while also letting the model `post_session_message`.
- Reintroducing a detached wait “for consistency” with Claude.
- Making the **model** drive `phase: 'trail'` (or narrating progress into the room) — trail is plugin-owned from the OpenCode transcript.
- Filtering trail the same way as answer chrome — Show work is meant to look like the terminal, not a cleaned reply.
- **Replacing multi-bond with a single `lastKnownSessionId` pin** — second attach starves the first → `idle_timeout`.
- **Awaiting inject or stall before the next `poll_connection`** — presence starve → `idle_timeout`.
- Weakening fence-aware chrome filtering in `mirror-chrome.ts` (`prepareMirrorText` / `isOperationalChrome`) — models wrap the connect banner in markdown fences because the skill shows it that way.
- Letting empty / chrome-only `external_agent` rows settle commands in `unansweredCommands` — that permanently suppresses a still-unanswered owner dispatch.
- Returning early on `adopt.changed` without a follow-up null-cursor seed — always re-poll with no `cursor_v2` plus `catch_up` after adopt. Do **not** consume the pre-adopt package: it was opened against the previous room.
- Advancing top-level live `cursor_v2`, independent `dispatch_cursor`, delivery ids, or `window.next_cursor` catch-up continuation before the corresponding immutable turn is accepted — a rejected `promptAsync` must mechanically retry the whole turn.
- Cold-launch paint timestamp reused as server `created_at` for `local_agent_dispatch` — wire order must be insertion time (DevSpecV2 chat route); optimistic UI may keep paint time locally.
- Mirroring the `/devspec.remote` connect turn (or NLP-guessing its narration as chrome) — connect skill replies are terminal-only; skipping them is by `command.executed` message id + handshake suppress (`shouldSkipConnectTurnMirror`), not by widening `isOperationalChrome`.

## Presence vs Cursor (why OpenCode used to drop mid-conversation)

Cursor keeps a **detached** Node poller (`devspec-remote-poll.mjs`) that heartbeats while the LLM works. OpenCode’s pump is **in-process** and used to `await` inject baseline (`session.messages`) + kickoff before returning to `poll_connection`. When that await hung or ran long, `last_seen` went stale and the server stamped `idle_timeout` (~90s) even though the bond still looked attached.

**Fix (item 875d75b5):** after claiming delivery ids and `setBusy(true)`, inject runs via fire-and-forget `deliverInjectedTurn` so the presence loop re-enters `poll_connection` immediately. `checkBusyStall` is also off the critical path (async) and `session.messages` on stall + inject baseline use `OPENCODE_SESSION_API_TIMEOUT_MS` (5s). Stories: `inject`/`queued` → `inject`/`kicked`, `pickup`/`started`, `presence_gap`, `ended` with `last_poll_age_ms`. Do **not** reintroduce awaiting inject before the next poll; do **not** treat `report_keepalive` as a substitute for `last_seen`.

## Failure modes

- Double reply: mirror + model both post the same answer.
- Stall: busy with **no observable progress** for the stall timeout (empty reply text *and* no new assistant step *and* no in-flight tool). Active tool loops slide the timer — text-only emptiness is not enough to stall (Tembo / Racing Heron false positives). See `decideBusyStall` / `checkBusyStall` and `poll.log`. Eternal “running” tool parts are capped by `MAX_SAME_ASSISTANT_ACTIVE_TOOL_SLIDES`.
- **Hung `permission.asked`** (item bb633917): a permission wait is **not** progress. `permission.asked` (plugin event) sets `permissionAskedPending` / `permissionAskedAt`; `decideBusyStall` never returns `slide`/`active_tool` while that is set, and stalls with story reason `permission_asked` after `PERMISSION_ASK_STALL_MS` (~15s) — sooner than the empty-assistant / multi-slide path (~minutes). Message-part detection (`messageHasPendingPermissionAsk`) is a belt-and-suspenders when the event is missed. Cleared on permission resolved/denied and whenever busy clears.
- **Auto-allow while bonded** (item 1514baa3): cold-launch `opencode run --auto` only covers the first connect turn. Later owner commands use `promptAsync` and do not inherit `--auto`. The plugin `permission.ask` hook sets `output.status = 'allow'` whenever any DevSpec remote-control bond is active in the process (unattended yolo for remote turns). Plain interactive TUI without a bond still prompts.
- **Presence starve → idle_timeout** (sessions Gentle Weasel / Crimson Osprey, 2026-08-07): poll never reached within ~90s after pickup or after a healthy turn. Look for client story `pickup` → silence → `ended`/`idle_timeout` with large `last_poll_age_ms`, or `poll_error`/`presence_gap`. Guard: fire-and-forget inject + non-blocking stall + session API timeouts.
- State lost-update between idle handler and mirror path.
- Fenced status banner → empty markdown-fence leftover posted as a blank bubble → seed-window treats it as a reply and settles a prior owner command (session `0ffe97cb`; fixed in `d9711ed` via fence-aware strip + chrome-aware `unansweredCommands`).
- Connect + attach lands, status banner prints, owner command never injects: pre-adopt package consumed as seed / cursor advanced past unanswered commands (sessions `1383cbb8`, `23da0643`). **Guard:** after `adopt.changed`, always re-poll with `cursor:null` + `catch_up` (`adoptRequiresNullCursorRepoll`); never fall through. Server: do not backdate `local_agent_dispatch` `created_at` to the optimistic paint time; honour `catch_up` in packaging.
- **Connect turn mirrored as a reply during a mid-attach dispatch** (session `e7ecc1de`): `/devspec.remote` prints terminal-only status plus process narration ("Oriented… Holding for long-poll…"). Banner strip leaves the narration; the mirror posts it; `unansweredCommands` treats it as the answer and drops the pending owner command from the seed inject. **Guard:** never mirror the connect skill turn — `command.executed` for `devspec.remote` / `devspec.remote-stop` records the assistant `messageID` in `nonMirrorMessageIds`, and register / first-attach sets `connectMirrorSuppressed` so a `flushMirrorNow` that races ahead of that event still skips. Cleared after the skip (or when awaiting a real inject reply). Do **not** NLP-widen chrome for "oriented/holding" prose; do **not** weaken the seed filter.
- **Late `command.executed` poisons the inject answer** (session `8a97effc` / connection `4aab7fe0`): OpenCode fires `devspec.remote` `command.executed` *after* inject against the answer message id. That id lands in `nonMirrorMessageIds`; mirror skips with `connect_turn_suppress` while `awaitingRemoteReply` is true, claims `lastMirrored`, and later polls say "already mirrored" — reply stays in the terminal only. **Guard:** `awaitingRemoteReply` wins — `shouldSkipConnectTurnMirror` never skips while awaiting; `recordRemoteControlSkillCommand` ignores `command.executed` while awaiting so the answer id is never recorded. Do **not** weaken `isOperationalChrome` / `prepareMirrorText` to paper over this.
- **Sibling agent reply settles OpenCode's unanswered dispatch** (session `5546c769` / command `c117ffae`): after OpenCode fails to mirror, Cursor posts in the same room; on OpenCode reconnect `unansweredCommands` treats that Cursor bubble as the answer and seed_filter drops the still-unanswered OpenCode dispatch (`already_answered`). **Guard:** pass `AGENT_NAME` + `connectionId` into `unansweredCommands` so only THIS agent's `external_agent` rows settle.
- **Second OpenCode session attach kills the first bond** (Ivory Panda / Racing Dolphin, 2026-08-07): one process stored a single `lastKnownSessionId`; the second `/devspec.remote` overwrote it, so the first connection stopped getting `poll_connection` and `idle_timeout`ed ~90s later. **Guard:** `rememberOpenCodeBond` map + pump iterates all bonds; `runWithBoundSession` scopes state; ending one bond does not stop the pump.

## Key files

| File | Responsibility |
|---|---|
| `src/plugin.ts` | Self-scheduling long-poll pump; `command.executed` → skip-mirror ids; dispose aborts in-flight hold |
| `src/remote-control.ts` | `pollAndDeliver`, `deliverInjectedTurn`, busy/stall, mirror, presence stories, disk state, `extractOpenCodeReplyModel`, `resolveOpenCodeAssistantModel` |
| `src/remote-ingress.ts` | Strict negotiated v1 envelope validation and atomic turn selection; authoritative contract: `devspec://product/remote-ingress-contract` |
| `src/poll-turn.ts` | Pure hold tiers, advisory carry/rendering, attachment references, cursor advance rules |
| `src/mirror-chrome.ts` | Fence-aware status strip / `prepareMirrorText` / `shouldSkipConnectTurnMirror` |
| `src/work-trail.ts` | Serialize in-flight turn → trail text (seed, throttle helpers, unfiltered parts) |
| `src/agent-identity.ts` | `AGENT_NAME = 'OpenCode'` |
| `src/devspec-client.ts` | MCP `tools/call` with timeouts |
| `commands/devspec.remote.md` / `devspec.remote-stop.md` | Skill steps for register/attach (act section, budgeted transcript, terminal-only chrome) |
| `~/.devspec/opencode-remote-control/poll.log` | Local diagnostics |

## Running tests after a remote-control change

### For coding agents

After any change under `src/remote-control.ts`, `src/poll-turn.ts`, `src/mirror-chrome.ts`, `src/plugin.ts` (remote pump path), or the related `test/*.test.mjs` files:

1. `cd` to the **plugin root** (`opencode-devspec-plugin` — the package that contains `package.json` with the `test` script).
2. Run:

```bash
npm test
```

That is the only required command. It builds (`tsc`) then runs `node --test test/*.test.mjs`. There is no separate `test:remote-control` script. Expect a full green suite (no phone / live DevSpec bond needed).

Do **not** ship a remote-control change without that suite passing. Prefer also reading this primer’s logging section before diagnosing “OpenCode left after I replied.”

### What `npm test` covers (remote-control subset)

- `test/presence-pump.test.mjs` — session API timeout, presence gap / ended stories, inject must not block a follow-up poll tick
- `test/multi-bond.test.mjs` — second remember keeps first bond; forget is per-bond; ALS state isolation
- `test/mcp-short-timeout.test.mjs` — hung MCP abort on the pump path
- `test/poll-turn.test.mjs` / `test/busy-stall.test.mjs` — hold tiers, stall policy
- `test/model-stamp.test.mjs` — `extractOpenCodeReplyModel` aliases, `resolveOpenCodeAssistantModel` (MiniMax flat + nested), loud `mirror_post`/`model_missing` story shape
- `test/work-trail.test.mjs` — serialize / seed / throttle / clamp for live Show work

### Optional live smell-test (after ship)

Unit green is necessary but not the whole story for presence. After installing / loading a new `dist/`: fully quit and relaunch OpenCode, attach → three short dispatches 30–60s apart → confirm no `idle_timeout` leave marker.

## Logging — reconstructing a connection story

Fragile remote sessions are debugged from two places that share one phase vocabulary:

| Source | Where | What |
|---|---|---|
| **Axiom (server)** | DevSpec MCP tool logs | `msg == "Remote-control story"` with `connectionId`, `sessionId`, `data.phase`, `data.outcome`, `reason` |
| **Local poll.log** | `~/.devspec/opencode-remote-control/poll.log` | Same phases as JSON lines prefixed `story ` (plus human `logPoll` lines). Kept for offline debug when Axiom is empty. |

**Shared phases:** `register` · `attach` · `seed_filter` · `inject` · `wake` · `mirror_decision` · `mirror_post` · `complete_turn` · `pickup` · `done` · `poll_error` · `stall` · `ended`

OpenCode client stories also cover: `inject`/`queued` then `inject`/`kicked`, `pickup`/`started`, `complete_turn`/`cleared`, `mirror_post`/`posted` (and `done`/`mirrored`), `poll_error`/`presence_gap` (starve warning), and `ended` with `last_poll_age_ms` + `end_reason` class (`idle_timeout` vs `ui` / `local_stop`).

**Model attribution (items f9e747bd, a4789863).** Inject / pickup / mirror / done stories carry `connectionId`, `sessionId`, and — when known — `model` (`providerID/modelID`). Mirror resolution uses `resolveOpenCodeAssistantModel`: flat assistant `info.providerID`/`modelID` (MiniMax and peers), then nested `info.model` / Model.Ref (`providerID`+`id`), then legacy `info.metadata.assistant`. When that fails (or a command `dispatch_model` fails `extractOpenCodeReplyModel`), the plugin emits `mirror_post`/`model_missing` (or `inject`/`model_missing`) with `model_shape`, `reason`, and `source` — never a silent drop. Grep local `poll.log` or Axiom for `outcome == "model_missing"` when DevSpec shows a reply with no model.

### Skill contract (passivity vs routing)

| Behaviour | Where |
|---|---|
| Act-on-owner-commands (do work in repo / verify with tools) | `commands/devspec.remote.md` — “Act on owner commands” |
| Budgeted attach transcript (`since_created_at` ~48h; skim newest ~40 if still large) | same skill, attach step |
| Instruction tiers from `attach_connection` (not uncapped transcript seed) | same skill |
| Loud model stamp failure | `resolveOpenCodeAssistantModel` / `extractOpenCodeReplyModel` + `logRemoteControlStory` in `src/remote-control.ts` |

### “OpenCode left right after I replied” — Axiom recipe

```
['devspec']
| where _time > ago(2h)
| where connectionId == "<connection-uuid>"
| where msg == "Remote-control story" or ['message'] contains "Remote-control story" or isnotnull(reason)
| sort by _time asc
| project _time, reason, ['message'], data, sessionId
```

Or filter local `poll.log`:

```
story {"phase":"pickup"...}
story {"phase":"inject","outcome":"queued"...}
story {"phase":"inject","outcome":"kicked"...}
story {"phase":"mirror_post","outcome":"posted","model":"…"} 
story {"phase":"mirror_post","outcome":"model_missing","model_shape":"…"}  # stamp failed — never silent
story {"phase":"done","outcome":"mirrored"...}
story {"outcome":"presence_gap"...}   # starve before server idle_timeout
story {"phase":"ended","reason":"idle_timeout","last_poll_age_ms":...}
```

| Pattern | Meaning |
|---|---|
| `pickup` then long silence then `ended`/`idle_timeout` + large `last_poll_age_ms` | Presence starved after hearing the command |
| Continuous polls, then `ended`/`ui` | Real detach / UI End |
| `inject`/`queued` never `kicked` | Inject never reached OpenCode `promptAsync` |
| No inject row for a dispatch | Poll already dead before the message landed |

**Axiom recipe** (dataset `devspec`) for a full connection timeline:

```
['devspec']
| where msg == "Remote-control story"
| where connectionId == "<connection-uuid>"
| sort by _time asc
| project _time, ['data.phase'], ['data.outcome'], reason, sessionId, ['data.agent'], ['data.tool']
```

**Local recipe:** open `poll.log` and grep `story ` for the same connectionId. Do not dump model token streams into either log.
