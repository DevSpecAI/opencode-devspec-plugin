# Remote control — OpenCode (LLM primer)

**Family:** native runtime (not local-poller).  
**Read first:** `docs/remote-control/remote-control-overview.md`.  
**Plugin repo:** `opencode-devspec-plugin` (`src/remote-control.ts`, `src/poll-turn.ts`, `src/mirror-chrome.ts`).

## How a message reaches OpenCode

1. Owner dispatches to this connection in DevSpec.
2. Plugin (inside the OpenCode process) calls held `poll_connection`.
3. On deliverable commands, plugin builds a turn via `renderInjectedTurn` (context labelled advisory; commands last).
4. Plugin calls `client.session.promptAsync` with `parts: [{ type: 'text', text }, …]` — **chat-message door**, not slash-command door.
5. OpenCode model runs a normal turn in that session.
6. Plugin mirrors the latest assistant reply via `prepareMirrorText` then `post_session_message` (chrome stripped; dedup against model-initiated posts).
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
- Returning early on `adopt.changed` without consuming the same poll’s packaged turn — the catch-up window for the new room is often already in that response; discarding it skips the owner’s pending command (session `1383cbb8`).
- Advancing the message cursor (in-memory `pump.cursor` **or** persisted `lastDeliveredMessageId`) when deliverable commands were present but not injected — the next poll’s `cursor` arg permanently skips them (`shouldAdvanceMessageCursor`).

## Failure modes

- Double reply: mirror + model both post the same answer.
- Stall: busy stuck with empty assistant text (see stall timeout / `poll.log`).
- State lost-update between idle handler and mirror path.
- Fenced status banner → empty markdown-fence leftover posted as a blank bubble → seed-window treats it as a reply and settles a prior owner command (session `0ffe97cb`; fixed in `d9711ed` via fence-aware strip + chrome-aware `unansweredCommands`).
- Connect + attach lands, status banner prints, owner command never injects: adopt discarded the seed package and/or cursor advanced past unanswered commands (session `1383cbb8`; fixed via adopt fall-through + `shouldAdvanceMessageCursor`).

## Key files

- `src/remote-control.ts` — poll loop, inject, mirror, busy
- `src/poll-turn.ts` — pure command gate + `renderInjectedTurn` + `unansweredCommands` + `shouldAdvanceMessageCursor`
- `src/mirror-chrome.ts` — fence-aware status strip / `prepareMirrorText` (shared by mirror + seed-window filtering)
- `src/agent-identity.ts` — `AGENT_NAME = 'OpenCode'`
- `commands/devspec.remote.md`
- `~/.devspec/opencode-remote-control/poll.log` — local diagnostics
