---
description: Just finished some work? Log it to DevSpec — commits, testing notes, and all
---

# DevSpec Done

The user's request: $ARGUMENTS

Record work that was completed outside DevSpec's action item workflow. Creates a completed action item retrospectively with implementation notes and linked commits.

## Steps

1. **Detect git state** — run these in parallel:
   - `git remote get-url origin` to get the remote (used for project resolution in step 1b)
   - `git log --oneline -10` to get recent commits
   - `git diff --stat HEAD~10..HEAD 2>/dev/null || git diff --stat` to get affected files
   - `git branch --show-current` to get branch name
   - `git log --format="%H %s" -10` to get full SHAs and messages

1b. **Resolve the project (account-wide token).** DevSpec MCP tokens are account-wide, so name the project this work belongs to. Call `list_projects({ git_remote: "<remote from step 1>" })`; use `remote_match.resolved_project_id` as `project_id`. If it is null with multiple `candidate_project_ids`, present them and ask the user which project. If there is no match, output `✗ No DevSpec project tracks this repo (<git_remote>).` and stop. Pass `project_id` on the `record_completed_work` call in step 4.

2. **If no recent commits exist**, ask the user for a title and what they implemented, then skip to step 4.

3. **If recent commits exist**, auto-generate ALL of these fields from the git history. Do NOT ask the user for input — infer everything:
   - `title`: Summarize the work in one line (imperative tense requirement, e.g., "Add user profile page" not "Added user profile page")
   - `description`: 2-3 sentences describing what was needed (imperative/future tense, as if written before the work)
   - `implementation_summary`: What was actually done, decisions made, trade-offs (past tense). **MUST use markdown formatting** — use `**bold**` for key terms, bullet lists (`-`) for distinct changes, inline `` `code` `` for file/function names, and blank lines between sections. Never write as a single prose paragraph.
   - `completion_summary`: User-friendly changelog entry (2-4 sentences). Written for end users, not developers
   - `testing_notes`: Numbered step-by-step manual testing instructions in markdown. Include what to click, what page to visit, and expected results. Specific enough for a non-developer tester
   - `usage_notes`: Where users can find this feature in the UI and how to use it. Written for end users
   - `commits`: Array of `{ sha, message }` from detected commits
   - `affected_files`: List of changed files from git diff
   - `branch`: Current branch name
   - `type`: Infer from commits (`fix` → `bug`, `feat` → `feature`, `refactor` → `improvement`, default `task`)
   - `priority`: Infer from scope — single file fix → `low`, multi-file feature → `medium`, critical/breaking → `high`
   - `tags`: Infer 2-4 relevant tags from changed files and commit messages (e.g., `ui`, `api`, `auth`, `layout`, `database`)
   - `browser_test_task`: Machine-executable test steps for an AI browser agent. Use `@{{url}}` as a placeholder for the deployment URL. Describe navigation, clicks, and expected outcomes. Set to empty string for non-UI work (backend, infra, refactors)
   - `testability_verdict`: One of `ready`, `needs_setup`, or `not_suitable`. `ready` = change is visible by simply navigating to a page. `needs_setup` = visible in browser but requires specific app/DB state first. `not_suitable` = cannot be browser-tested (backend-only, infra, logging)
   - `testability_rationale`: Brief explanation of why this verdict was chosen

4. **Immediately call `record_completed_work`** (do NOT wait for confirmation) with:
   - `project_id` (resolved in step 1b — required on this project-scoped call)
   - `title`, `description`, `implementation_summary` (required)
   - `type`, `priority`, `tags`, `commits`, `affected_files`, `branch`
   - `completion_summary`, `testing_notes`, `usage_notes`
   - `browser_test_task`
   - `testability_verdict`, `testability_rationale`
   - `provider`: always pass `"opencode"`

5. **Output a brief summary** — no filler, just the result:
   ```
   ✓ Recorded: {title}
     {id (first 8)} · {type} · {priority} · {tags}
     {N} commits · {N} files · branch: {branch}
   ```

## Rules

- Do NOT ask the user to confirm, review, or edit the draft. Just create it immediately
- Do NOT ask about priority, tags, type, or any other field — infer everything from git history
- The user can edit the action item afterward if anything needs changing
- You MUST use `record_completed_work` — do NOT use `create_action_item`, `update_action_item`, or raw SQL to create the action item
- Do NOT use direct SQL or Supabase MCP — all updates go through DevSpec MCP tools
- Write the title and description as a **requirement** (imperative tense), not as a past-tense summary
- The completion_summary should be written for end users, not developers
- The testing_notes MUST be numbered step-by-step instructions a non-developer can follow
- The usage_notes should describe where to find the feature and how to use it
- ALL fields are required — do not skip any
