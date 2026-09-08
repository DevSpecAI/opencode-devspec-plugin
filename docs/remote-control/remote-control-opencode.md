# Remote control: OpenCode

**Audience:** coding agents changing OpenCode remote-control behavior.
**Family:** native runtime, not local-poller.
**Read first:** `docs/remote-control/remote-control-overview.md`.

## Non-Negotiable Rules

1. **Presence is the bond.** A successful `poll_connection` updates `last_seen`; `report_keepalive` alone does not. Anything that blocks polling for roughly 90 seconds can end a healthy connection with `idle_timeout`.
2. **One OpenCode conversation equals one bond.** State is keyed by the OpenCode session id. Several conversations in one process may each attach to different DevSpec rooms.
3. **The agent owns answer content.** A bonded model calls `post_session_message` exactly once with the complete answer. The plugin never reads terminal assistant text to author, recover, or duplicate that answer.
4. **The plugin owns routing and lifecycle.** It overwrites model-supplied identity, target, phase, completion, model stamp, and command correlation with facts from the firing bond.
5. **Unbonded sessions fail closed.** A child, sibling, or unrelated OpenCode conversation cannot post through another conversation's DevSpec attachment.
6. **Remote prompts are serialized.** A second `promptAsync` command waits until the current answer settles so its exact command ids cannot replace the first turn's correlation. A pending OpenCode question is the exception because the next owner command goes to `question.reply`, not a new prompt.
7. **Sessionless connections invent no chat.** Explicit automation runs use their own claim/report workflow.
8. **Connect/status output stays terminal-only.** `/devspec.remote` and `/devspec.remote-stop` are protocol turns, not conversational answers.

## Architecture

```text
OpenCode process
  plugin.ts
    multi-bond loop
      runWithBondAsync(openCodeSessionId)
        pollAndDeliver
          report activity / check stall asynchronously
          held poll_connection
          validate canonical ingress
          serialize prompt acceptance
          setBusy(true)
          fire-and-forget deliverInjectedTurn
            timed session.messages baseline
            session.promptAsync
            commit accepted ids and cursors

  model-owned answer
    post_session_message({ message })
      tool.execute.before
        require firing session bond
        reserve one answer post for this OpenCode turn
        resolve current connection and model
        overwrite routing and lifecycle fields
        bind exact remote command ids, or mark a local turn unbound
      DevSpec MCP call
      tool.execute.after
        require returned message_id
        settle local busy, trail, permission, and correlation state
```

There is no detached inbox process, wait process, Stop-hook answer post, assistant-text fallback, or second full-answer writer.

## Message Flow

1. DevSpec supplies a canonical exact-target command through `poll_connection`.
2. The plugin validates authority and scope against the negotiated remote-ingress contract.
3. The plugin records the canonical turn id and final ordered command message id before scheduling `promptAsync`.
4. The injected prompt tells OpenCode to act on the command and call `post_session_message` once before its final terminal response.
5. The tool before-hook replaces any supplied routing with the bond's current `connection_id`, `agent_name: "OpenCode"`, `turn_kind: "agent"`, `phase: "answer"`, and `complete_turn: true`.
6. Remote answers receive `command_turn_id` and `command_message_id`. Local terminal answers in the same bonded conversation receive `command_turn_unbound: true`.
7. Only a successful result carrying `message_id` settles the turn. Failed or malformed results leave it retryable.
8. `session.idle` never reads assistant text. If a remote turn omitted the required post, it attempts one bounded mechanical error against the exact command. Failed error settlement preserves the command and correlation; confirmed settlement unclaims the command for retry.

## Presence And Timing

| Constant | Value | Role |
|---|---:|---|
| `ATTENDED_HOLD_MS` | 25s | Held poll while attached or working |
| `IDLE_HOLD_MS` | 30s | Held poll while sessionless or idle |
| `HOLD_HTTP_GRACE_MS` | 15s | HTTP ceiling above the server hold |
| `PRESENCE_GAP_WARN_MS` | 60s | Warn before server idle timeout |
| `OPENCODE_SESSION_API_TIMEOUT_MS` | 5s | Session history ceiling for trail, stall, baseline, and model metadata |
| `MCP_SHORT_CALL_TIMEOUT_MS` | 10s | Ordinary MCP ceiling |
| `STALL_TIMEOUT_MS` | 120s | No-progress timeout, configurable with `DEVSPEC_OPENCODE_STALL_MS` |

Never await `deliverInjectedTurn`, `checkBusyStall`, or an unbounded session API call before returning to `poll_connection`. The poll is the heartbeat.

## Work Trail

The plugin may post `phase: "trail"` while a remote turn runs. Trail content is mechanical progress, not answer authorship.

| Piece | Behavior |
|---|---|
| Source | `src/work-trail.ts` serializes in-flight assistant parts |
| Seed | `Working...` when OpenCode accepts the turn |
| Growth | Full replacement, throttled, hash-skipping unchanged snapshots |
| Content | Unfiltered tool calls, reasoning, failures, and output |
| Close | The model-owned `phase: "answer"` post closes the row atomically |

The pre-inject assistant baseline remains only to scope trail and stall observations to the current remote turn. It is not an answer cursor.

## Permissions And Questions

- A permission wait is resumable activity, not model progress and not a terminal stall.
- OpenCode 1.18.21 does not invoke the declared `permission.ask` hook, so configured local permission rules remain authoritative.
- DevSpec cannot answer a local-only OpenCode permission prompt remotely.
- `question.asked` posts structured `phase: "needs_input"` state. The next canonical owner command answers that request through `question.reply` without starting a second prompt.
- A stale permission or question reply cannot clear a newer request.

## State

Bond state under `~/.devspec/opencode-remote-control/` contains:

- connection and current attachment identity
- independent ingress, catch-up, and automation cursors
- delivered command and automation ids
- current command turn/message correlation
- busy, stall, permission, question, and work-trail state
- one-turn answer-post reservation and success latch

Use `patchState` for concurrent updates. Do not write a stale full snapshot over cursor, correlation, or answer-post state.

## Failure Modes

- **Duplicate answer:** a second answer tool call in the same OpenCode turn is rejected before MCP execution.
- **Wrong-room child post:** unbonded tool calls are rejected before MCP execution.
- **Overlapping command correlation:** follow-up prompt injection is deferred while `awaitingRemoteReply` is true.
- **Post failed or returned no `message_id`:** answer reservation is released, but activity and command correlation remain open.
- **Idle without answer:** exact-correlated mechanical error; preserve state if that error cannot be confirmed.
- **Permission wait:** keep active attempt and correlation until permission resolution or terminal session settlement.
- **Presence starvation:** look for `pickup`, then a long poll gap, then `ended` with `idle_timeout`.
- **Attachment change:** use server attachment truth and re-poll with null cursor plus `catch_up`; never consume a pre-adopt package as the new room's seed.
- **Concurrent chats or processes:** every OpenCode chat and every OpenCode process holds its own bond keyed on its own OpenCode session id; nothing collides or starves another bond. Scope every state mutation with the firing OpenCode session id.

## Key Files

| File | Responsibility |
|---|---|
| `src/plugin.ts` | Bond gate, answer argument binding, post settlement, event loop |
| `src/remote-control.ts` | Poll/inject, state, exact correlation, activity, stall, permissions, questions |
| `src/remote-ingress.ts` | Canonical ingress validation and selection |
| `src/poll-turn.ts` | Hold tiers, prompt rendering, cursor rules, attachments |
| `src/remote-format.ts` | Content-blind markdown formatting and connect sequencing |
| `src/work-trail.ts` | In-flight progress serialization and throttling |
| `commands/devspec.remote.md` | Connect/attach and agent-owned answer instruction |
| `instructions/devspec.md` | Bonded local-terminal answer instruction |

## Verification

Run from the plugin root:

```bash
npm run typecheck
npm test
git diff --check
```

Relevant regressions include:

- `test/single-writer-egress.test.mjs`: exact routing, duplicate suppression, unbonded refusal, permission/local sequence, and idle failure handling
- `test/canonical-poll-delivery.test.mjs`: immutable prompt acceptance, deferred follow-ups, and independent cursors
- `test/plugin-event-bond-gate.test.mjs`: child/sibling event isolation
- `test/busy-stall.test.mjs`: no-progress, permission, and abnormal settlement behavior
- `test/work-trail.test.mjs`: trail scope and throttling
- `test/model-stamp.test.mjs`: actual OpenCode model-shape resolution

After installing a new `dist/`, fully quit and relaunch OpenCode. Partial reloads can leave the old in-process pump alive.

## Logging

Useful story phases are `register`, `attach`, `seed_filter`, `inject`, `wake`, `answer_post`, `complete_turn`, `pickup`, `done`, `poll_error`, `stall`, and `ended`.

```text
story {"phase":"pickup","outcome":"started"...}
story {"phase":"inject","outcome":"queued"...}
story {"phase":"inject","outcome":"kicked"...}
story {"phase":"answer_post","outcome":"posted"...}
story {"phase":"complete_turn","outcome":"cleared"...}
```

Local diagnostics are in `~/.devspec/opencode-remote-control/poll.log`. Server-side stories use the same connection/session identifiers.
