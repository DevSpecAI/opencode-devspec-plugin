# Commit provenance in OpenCode — capability table

Implements the OpenCode share of ADR `71c23b46` under brief `e3d3b54f`, item
`f240d17f`. Memory `26aab381` is binding. Authority and lifecycle sit in the
served contract at `devspec://product/implementation-contract`; this file only
records what OpenCode actually exposes.

Each row says what this host *actually* exposes, what the plugin therefore
does, and — where the answer is "nothing" — what covers the gap. Nothing here
is ported from another host.

## What OpenCode exposes, and what we do with it

| Surface | OpenCode capability | What this plugin does | Gap covered by |
|---|---|---|---|
| **Edit events** (`edit`, `write`) | `tool.execute.after` fires after the write; `before` can throw (that would *deny*) | **Never denies.** Appends at most one reminder to the tool result per session+project when a pin exists and no claim is held | Instructions keep early claiming as the normal workflow |
| **Arbitrary execution** (`bash` and every other tool) | `tool.execute.before` sees the tool name and `args` | **Never denies** for lack of a claim. No allowlist, no tokenizer over arbitrary commands, no unknown-tool classification | — |
| **Commit message inspection** | Only a string: `bash` args `command` / `cmd`. No first-class commit event | Reads the message from the narrow `git commit … -m <quoted>` shape, including a leading `cd <single-path> &&` and `git -C <path>`. Every other shape is allowed untouched | Server-side commit ingestion + unlinked-commit analyzer |
| **Commit message transformation** | **Yes** — `tool.execute.before` may mutate `output.args` (already used for `register_connection.local_id`) | Appends `[devspec:<uuid>]` inside the quoted message when exactly one session claim is active, and reports it on the tool result | — |
| **Push observation** | The `git push` command string is visible on `bash` | **Recognised but never blocked.** OpenCode does not expose outgoing commit objects, and this item does not invent a history rewrite or a network linkage check | Analyzer |
| **Project association** | Plugin `directory` plus `.devspec/project.json`; `/devspec.remote` already *offers* to write a pin | Jurisdiction is a well-formed pin walked cwd→parents, never at `$HOME`. The plugin never writes the pin. No pin means no deny and no nudge. **Known gap (`f81e105d`): the repository's main working tree is not consulted, so a session running in a linked worktree has no jurisdiction at all** — the pin is untracked and lives in the main checkout, while the contract asks for isolated worktrees | Ingestion never depends on a pin. The contract states what this must meet: jurisdiction is a property of the repository, not of the working directory (`commit_provenance_contract.project_association`) |
| **Offline / server error** | n/a — this module makes no network call | Reference checking is **local shape only**. Offline work is unaffected | Server-side linkage catches a well-formed-but-wrong uuid |
| **Feedback continuation** | Throwing from `tool.execute.before` fails one tool call and returns the error; it does not end the session | Denials carry a complete recovery route. No terminate/stop field is emitted | — |
| **Session identity** | Every hook carries `sessionID` | Claims and the one nudge are session-scoped. Remote `local_id` injection, bonds, and egress are unchanged | — |
| **Installed testing** | The plugin is an in-process TypeScript module | `commit-provenance.test.mjs` drives the real `DevSpecPlugin` hooks, not only imported helpers | — |

## When a commit is denied — the whole list

Only when all of these are true:

1. The `bash` command is a readable simple commit (including the two worktree forms).
2. A positive local pin exists.
3. The visible message has **no** well-formed `[devspec:<id>]` (full uuid or 8-char short code).
4. The message is not ambiguous (two or more well-formed references).
5. Stamping is not available (no single active claim, or the message is not safely transformable).

Everything else allows, including: a reference already present, no pin, a shape we cannot read, unknown tools, `git push`, unreadable claim state, and a plugin restart.

## Why `cd <path> &&` and `git -C <path>` are readable

Isolated worktrees are required. Reaching one from OpenCode's `bash` tool needs
one of those two forms. Neither can author a commit or change which verb runs.
A second separator, a prefix that is not exactly `cd <one-path>`, or any other
global option still refuses — and refusing still means allow.

## Deliberate holes

**A well-formed reference is not verified to exist.** Shape only. Online
`validate_commit_reference` is a separate item and is not wired here.

**An unquoted message cannot be stamped.** Appending ` [devspec:…]` to an
unquoted word would make it a separate git pathspec.

**Push is never blocked.** Certainty about outgoing history and a safe
idempotent recovery are not available on this host without inventing a git
inspector or a network dependency.

## What this replaced

`track-before-mutation.ts` is deleted, not disabled. With it goes the mutation
alias list, the read-only shell tokenizer, and claim-gated denial of edits,
shell, unknown tools, and post-record follow-through.

Historical items `cdd7a494` and `dfa86f3f` remain valid evidence of what was
true then. This supersedes their OpenCode enforcement architecture.

## What this is not

Cooperative provenance assistance. OpenCode permissions, remote delivery,
native OpenCode-only remote slashes, session identity, and host sandboxing are
independent and unchanged.
