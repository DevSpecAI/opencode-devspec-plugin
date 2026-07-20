---
description: Verify the DevSpec connection. Two modes — "Run the DevSpec connection check" (no ID) pings DevSpec through your token to prove agent+plugin+token, no git involved; "Run the DevSpec verify tool with ID <uuid>" pushes a tagged verification commit to each tracked repo and reports the per-repo result.
---

# DevSpec Verify Connection

The user's request: $ARGUMENTS

Prove the end-to-end loop the setup wizard cares about: that **this coding agent** can execute a tool, push to GitHub, and have DevSpec receive the webhook — for **every** repo the project tracks. This is distinct from `devspec.work` / item verification; it does not touch action items.

The setup wizard hands the user one of two prompts. Pick the mode by whether a verification UUID is present — never ask for one:

- *"Run the DevSpec connection check"* (no UUID) → **Ping mode** below. This is the personal wizard's git-free check.
- *"Run the DevSpec verify tool with ID `<uuid>`"* → **Commit mode** (the numbered steps). This is the project wizard's repo round-trip.

## Ping mode (no verification ID)

Call `verify_agent_connection` with no arguments. That single token-authenticated call is the whole proof: DevSpec stamps your token as agent-verified, and the user's wizard step turns green by itself within a few seconds. It needs no project, no repo, and no git — it works during first-time onboarding before any project exists.

Print exactly:
```
✓ DevSpec connection verified
  Connected as: {connected_as from the response, or the token owner}
  Your setup wizard step will turn green automatically.
```
On an error, print `✗ DevSpec connection failed: {error}` and suggest checking that the token in the MCP config is the one just created. Do not fall through to commit mode.

## Commit mode steps

1. **Extract the verification ID** (a UUID) from the user input.

1b. **Resolve the project (account-wide token).** DevSpec MCP tokens are account-wide, so name the project before calling `get_project_summary`. Run `git remote get-url origin` and call `list_projects({ git_remote: "<that remote>" })`; use `remote_match.resolved_project_id` as `project_id`. If it is null with multiple `candidate_project_ids`, present them and ask the user which project. If there is no match, output `✗ No DevSpec project tracks this repo (<git_remote>).` and stop. (`report_connection_check` self-resolves its project from the `verification_id` and takes no `project_id`.)

2. **Fetch the target repos.** Call `get_project_summary({ project_id })` and read its `repos` array — each entry is `{ id, full_name, target_branch, default_branch }`. This is the authoritative per-repo branch map; do NOT guess branches and do NOT ask the user for them. The branch to push for a repo is `target_branch` if set, otherwise `default_branch`, otherwise `main`.

3. **Build the verification commit message — do NOT construct your own tag.** It is exactly:
   ```
   chore: verify DevSpec [devspec-verify:<ID>]
   ```
   where `<ID>` is the verification UUID from step 1. The `[devspec-verify:<ID>]` marker is what DevSpec matches; it is deliberately different from the `[devspec:<id>]` work-item trailer — never substitute one for the other.

4. **Find which target repos you have locally.** For each repo in `repos`, look for a local clone whose `origin` remote matches its `full_name`:
   - Check the current working directory and any sibling repositories in the workspace.
   - Compare with `git -C <path> remote get-url origin`, matching case-insensitively and ignoring a trailing `.git` and ssh-vs-https differences (e.g. `git@github.com:Org/Repo.git` and `https://github.com/org/repo` both match `Org/Repo`).

5. **For each target you found locally**, push the tagged empty commit to its branch. Run, in that repo's directory:
   ```bash
   git -C <path> fetch origin <branch>
   git -C <path> commit --allow-empty -m "chore: verify DevSpec [devspec-verify:<ID>]"
   git -C <path> push origin HEAD:<branch>
   ```
   - Push to the resolved **target branch** (`HEAD:<branch>`), NOT whatever branch the checkout happens to be on.
   - Record the outcome as `pushed` **only if `git push` exits 0**. If the push is rejected (e.g. non-fast-forward) or errors, record it as `skipped` with a short `reason` (e.g. "push rejected — pull and retry") — never report `pushed` for a push that did not succeed.

6. **For each target with no local clone**, record it as `skipped` with `reason: "not cloned locally"`. Never silently drop a repo.

7. **Report every target back to DevSpec.** Call `report_connection_check` with:
   - `verification_id`: the UUID from step 1
   - `results`: one entry per target — `{ repo: <full_name>, outcome: "pushed" | "skipped", reason?: <string>, branch?: <branch> }`

8. **Print a human-readable summary:**
   ```
   ✓ DevSpec verify
     Pushed:  {N}  →  {repo @ branch}, ...
     Skipped: {M}  →  {repo} ({reason}), ...
   ```

## Rules

- Do NOT output filler text before or after the summary.
- Reuse the per-repo branch map from `get_project_summary` — do not invent branches or fetch them another way.
- The commit message tag is `[devspec-verify:<ID>]`, rebuilt from the bare ID — never accept a pre-built message string and never use `generate_commit_message` (that emits the wrong tag).
- Only report `pushed` when the push genuinely succeeded (exit 0). A rejected/failed push is a `skipped` with a reason.
- This command uses your own git credentials and MCP token — that is the point (it proves the agent's connection, not the human's).
- If scope error (read-only token) when calling `report_connection_check`:
  ```
  ✗ Read-only token — cannot report verification.
    Generate a read-write token in DevSpec: Settings > MCP Tokens.
  ```
