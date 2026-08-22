# Working with DevSpec

This project is connected to DevSpec over MCP. DevSpec indexes the codebase and provides shared project records; use it proactively, not just when asked.

1. **Enter work through the canonical contract.** Before planning, action-item mutation, or implementation, read `devspec://product/implementation-contract` and apply its `work_entry_contract`. It is the sole authority for tracking choice, request authority, action-item lifecycle, claims, and completion; do not replace it with copied local prose.
2. **Check DevSpec first.** Before broad code search, query the DevSpec MCP tools (`search_index`, `get_action_items`, `get_project_summary`, `search_memories`) — the project is already indexed.
3. **Keep shared memory fresh.** DevSpec memory (`record_memory`, `search_memories`, `supersede_memory`, `retract_memory`) is the team's shared source of truth. Search first, read the closest match in full, and supersede rather than duplicating durable decisions, conventions, architecture, or risks.
4. **Respect project standards.** Read applicable conventions and decisions in full before relying on or contradicting them.
5. **Do not force conflicts.** Never force past a `possible_conflict` rejection without explicit human direction.

## Session plans — high threshold, on demand

The served implementation contract decides whether session-plan tracking is warranted. Routine reading, search/inspect/answer, and other work with no material shared interruption, coordination, or handoff value should add **no plan** and no plan prompt footprint.

Only after the contract selects a session plan, load `manage_plan` on demand with `search_devspec_tools` if it is not already available. Its complete mechanics are:

- Actions: `create`, `list`, `get`, `update`, `start_step`, `complete_step`, `skip_step`, `fail_step`, `advance`, `complete`, `abandon`, `adopt`.
- `create` uses `title` plus ordered milestone `steps` (`title`, optional `description`). Steps are meaningful phases, not tool calls.
- Every existing-plan mutation uses the authoritative positive `expected_revision`. Omit `plan_id` only for the connection's default-own plan; intentional cross-plan reads or mutations must include the exact `plan_id` and `expected_revision` shown by DevSpec.
- Prefer `advance` at a phase boundary: it atomically completes `current_step_id`, optionally applies authoritative `steps`, and starts `next_step_id`. Use single-step actions only when that is the actual transition. `fail_step` requires `reason` and `retryable`.
- An active plan must continue or end explicitly with `complete` (outcome achieved) or `abandon` (specific `reason`). Closing a plan does not end the session.
- `list` and room-delivered active-plan projections provide advisory read-awareness across the room. They grant no mutation authority. `adopt` is only for an orphaned same-owner plan in the same session, on explicit continuation intent; never adopt another owner's or a non-orphaned plan.

`manage_plan` caller identity and session are supplied mechanically by this plugin's hidden connection capability. Never pass or invent a connection id, session id, owner, or capability.

## Naming consistency

This plugin ships two commands, named identically to the equivalent Claude Code and Cursor DevSpec integrations — `devspec.remote` and `devspec.remote-stop`. Do not invent OpenCode-specific names for them.

There is no command for working an item, creating one, or recording finished work. Ask in plain language and use the DevSpec MCP tools directly; their schemas and the served implementation contract carry current guidance.

## Git & worktrees

Follow the repository and commit rules returned by `devspec://product/implementation-contract` and the project's current workflow settings. Do not infer push, merge, completion, or verification authority from this local file.
