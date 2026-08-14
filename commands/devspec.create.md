---
description: Create an action item in DevSpec from the terminal
---

# DevSpec Create

The user's request: $ARGUMENTS

Create a new action item in DevSpec without leaving the terminal.

## Steps

0. **Resolve the project (account-wide token).** DevSpec MCP tokens are account-wide, so name the project the item belongs to. Run `git remote get-url origin` and call `list_projects({ git_remote: "<that remote>" })`; use `remote_match.resolved_project_id` as `project_id`. If it is null with multiple `candidate_project_ids`, present them and ask the user which project. If there is no match — or there is no remote — **and there is no pin**, output `✗ No DevSpec project tracks this repo (<git_remote>), and there is no .devspec/project.json pin.` and stop. **With a pin, carry on** and pass `pinned_project_id` instead. Pass `project_id` on the `create_action_item` call in step 3.

   **Folder pin — a project with no repo yet.** Whether or not there is a remote, read `.devspec/project.json` in the workspace root if it exists; it holds `{ "project_id": "<uuid>" }`. That is how a folder whose code does not exist yet names its project. Pass it as **`pinned_project_id`**, NEVER as `project_id`: `project_id` is an explicit override that outranks a verified git remote, whereas the pin is only a local assertion the server deliberately ranks BELOW a remote it can verify — so sending it as `project_id` reverses that. Send `git_remote` when you have one, `pinned_project_id` when you have one, both when you have both, and let the server arbitrate. **Never decide precedence locally.**

1. Extract from the user's input:
   - `title`: required — the action item title
   - `description`: optional — detailed description
   - `type`: optional, default `task` (accept: `bug`, `feature`, `improvement`, `task`, `query`)
   - `priority`: optional, default not set (accept: `low`, `medium`, `high`, `critical`)
   - `suggest_human_only`: optional boolean — pass `true` ONLY for plainly off-platform work no agent could do (e.g. "call the lawyer", "buy the domain"). It is a suggestion a human confirms in DevSpec. Everything else needs no flag.

2. If no title is provided, ask the user for one.

3. Call `create_action_item` with the extracted parameters **plus `project_id`** (resolved in step 0).

4. If the call fails with a scope error (read-only token), output:
   ```
   ✗ Read-only token — cannot create action items.
     Generate a read-write token in DevSpec: You → Connections → Connect a tool (Read & write).
   ```

5. On success, output:
   ```
   ✓ Action item created
     ID:       {id (first 8 chars)}
     Title:    {title}
     Type:     {type}
     Priority: {priority or "not set"}
   ```

   If `suggest_human_only: true` was passed, append: `  Human-only: suggested (a human confirms in DevSpec)`

## Rules

- Do NOT output filler text before or after the confirmation
- Keep output compact
- Pass `suggest_human_only: true` only for plainly off-platform work — never for code or platform work, even if the user says "manual" or "no autopilot" (any open item can simply stay unstaged)
