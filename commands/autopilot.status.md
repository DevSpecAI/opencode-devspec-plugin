---
description: Show the current state of the DevSpec autopilot
---

# Autopilot Status

Fetch current state and output a compact status panel. Make all API calls in parallel.

## Steps

0. **Resolve the project (account-wide token).** DevSpec MCP tokens are account-wide, so resolve the project per run. Run `git remote get-url origin` and call `list_projects({ git_remote: "<that remote>" })`; use `remote_match.resolved_project_id` as `project_id`. If it is null with multiple `candidate_project_ids`, ask the user which project. If there is no match, output `✗ No DevSpec project tracks this repo (<git_remote>).` and stop. Pass `project_id` on the calls below.
1. Call `get_project_summary({ project_id })` for settings, `get_action_items` with `project_id, agent_activity: 'staged'` for staged count, and `get_action_items` with `project_id, agent_activity: 'in_progress'` for active count — **all in parallel**
2. Output:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ◆  DEVSPEC AUTOPILOT  ▸  {ONLINE/OFFLINE}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  interval: {N}s  ·  push: {on/off}  ·  merge: {on/off}

  staged:       {N} items
  in progress:  {N} items
  completed:    {N} items (this session)
  failed:       {N} items (this session)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Rules

- Use `on`/`off` for booleans
- Use tracked session state for completed/failed counts (if autopilot is running)
- Do NOT output filler text before or after the banner
