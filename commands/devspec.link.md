---
description: Link a git commit to a DevSpec action item
---

# DevSpec Link

The user's request: $ARGUMENTS

Associate a git commit with a DevSpec action item for traceability.

## Steps

1. Extract from user input:
   - `commit_sha`: required — the git commit SHA
   - `action_item_id`: required — the DevSpec action item ID
   - `commit_message`: optional — the commit message (auto-detect from SHA if not provided)

2. If either required parameter is missing, ask the user.

3. If commit_message not provided, try to detect it:
   - Run `git log --format="%s" -1 {commit_sha}` to get the message

4. Call `add_commit_reference` with the parameters.

5. If the action item ID is invalid, output:
   ```
   ✗ Action item not found: {id}
   ```

6. If scope error (read-only token):
   ```
   ✗ Read-only token — cannot link commits.
     Generate a read-write token in DevSpec: Settings > MCP Tokens.
   ```

7. On success:
   ```
   ✓ Commit linked
     SHA:    {commit_sha (first 8 chars)}
     Item:   {action_item_id (first 8 chars)}
     Ref ID: {reference_id (first 8 chars)}
   ```

## Rules

- Do NOT output filler text before or after the confirmation
- Accept both full and short SHA formats
