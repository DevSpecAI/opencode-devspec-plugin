# Working with DevSpec

This project is connected to DevSpec over MCP. DevSpec indexes the codebase and tracks work as action items — use it proactively, not just when asked.

1. **Check DevSpec first.** Before broad code search or planning, query the DevSpec MCP tools (`search_index`, `get_action_items`, `get_project_summary`, `search_memories`) — the project is already indexed.
2. **Track work as action items.** For anything non-trivial, create or claim a DevSpec action item (`create_action_item` / `claim_work_item`) *before* writing code. One unit of work = one item. This applies to any code you will commit — it does not apply to read-only exploration, answering questions, or purely conversational replies.
3. **Tag your commits.** End every commit that implements a tracked item with `[devspec:<id>]` so DevSpec links it automatically (and doesn't create a duplicate stub from the push webhook).
4. **Record what you did.** Once the work is pushed, call `record_implementation` with the commit SHA, affected files, and testing notes. Never mark an item `done` yourself — a human verifies it via `verify_action_item`. The canonical lifecycle is: staged → claimed → implementing → implemented → verified → done.
5. **Keep the shared memory fresh.** DevSpec memory (`record_memory`, `search_memories`, `supersede_memory`, `retract_memory`) is your team's shared source of truth — the in-app assistant and every other connected agent read it. When you learn something durable about the project (a decision, convention, architecture fact, or risk), record it — search first, and supersede the closest match rather than duplicating. Shared project knowledge belongs in DevSpec, not in this file or any other local-only notes.
6. **Respect project standards.** Check `get_conventions` / `get_decisions` before non-trivial changes — someone may have already decided this.
7. **Briefs group related work.** A brief is a parent action item that groups related children; use `create_action_item` with `parent_action_item_id` to attach a child, or `is_brief: true` to start a new one. A brief resolves automatically once every child is verified, dismissed, or deferred.
8. **Don't force past a conflict.** If `claim_work_item` rejects a claim with a `possible_conflict`, that means a human should resolve it (discuss, supersede, link, or dismiss) — don't pass `force: true` just to proceed unless a human has explicitly told you to.

## Naming consistency

This plugin's commands are named identically to the equivalent Claude Code and Cursor DevSpec integrations — `devspec.work`, `devspec.brainstorm`, `devspec.commit`, `devspec.done`, `devspec.create`, `devspec.link`, `devspec.help`, `devspec.remote`, `devspec.remote-stop` — so guidance and muscle memory carry over between tools. Do not invent OpenCode-specific names for these.

## Git & worktrees

Do implementation work in its own git worktree when the project uses one (many agents may be working in parallel). Commit only the files you changed. Push and merge per the project's configured target branch — check `get_project_summary` / `get_workflow_rules` for the project's actual `auto_push` / `auto_merge` settings and target branch rather than assuming.
