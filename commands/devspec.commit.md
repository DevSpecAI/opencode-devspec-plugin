---
description: Generate a deployment-tracked commit message and execute git commit
---

# DevSpec Commit

The user's request: $ARGUMENTS

Generate a properly formatted commit message with a `[devspec:<id>]` tag for deployment tracking, then automatically execute the git commit.

## Steps

1. **Check for staged changes** — run `git diff --cached --stat`.

2. If nothing is staged, output and stop:
   ```
   ✗ No staged changes. Stage your changes with `git add` first.
   ```

3. **Extract from user input**:
   - `action_item_id`: required — the DevSpec action item ID this commit is for
   - `summary`: required — short summary of what the commit does (under 72 chars)
   - `type`: optional, default `feat` (accept: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`, `perf`)
   - `body`: optional — longer description for the commit body

4. If action_item_id or summary not provided, ask the user.

5. Call `generate_commit_message` with the parameters.

6. Run `git commit -m "{generated_message}"` using the full message returned by the MCP endpoint.

7. Get the commit SHA with `git rev-parse --short HEAD`.

8. Output:
   ```
   ✓ Committed
     SHA:     {short_sha}
     Message: {subject line}
     Tag:     [devspec:{id}]
   ```

## Rules

- Do NOT output filler text before or after the confirmation
- The MCP endpoint generates the message — do not construct it yourself
- The `[devspec:<id>]` tag in the message is what DevSpec uses to link the commit and track the deployment
- If the commit fails (e.g., pre-commit hook), show the error and do NOT retry automatically
