---
description: Brainstorm on a DevSpec action item to refine scope, approach, and edge cases
---

# DevSpec Brainstorm

The user's request: $ARGUMENTS

Interactively brainstorm on an action item to sharpen its scope, surface edge cases, and explore implementation approaches — then save the results back to DevSpec.

## Steps

0. **Resolve the project (account-wide token).** DevSpec MCP tokens are account-wide, so resolve which project to operate on before any project-scoped call. Run `git remote get-url origin` and call `list_projects({ git_remote: "<that remote>" })`; read `remote_match`. Use `resolved_project_id` (non-null) as the session variable `project_id`. If it is null with multiple `candidate_project_ids`, present the candidates and ask the user which project to use. If there is no match, output `✗ No DevSpec project tracks this repo (<git_remote>).` and stop. Thread `project_id` on the project-scoped calls below (`get_action_items`, `search_memories`). The item-addressed calls (`get_action_item_history`, `add_implementation_note`, `update_action_item`, `spin_off_action_item`) self-resolve from the item id and take no `project_id`.

1. **Resolve the action item.** Extract an action item identifier from the user's input (ID, partial ID, or title keywords).
   - If an ID (or partial ID) is provided, call `get_action_items({ project_id, status: "all" })` and match by ID prefix.
   - If keywords are provided instead, call `get_action_items({ project_id, status: "all" })` and match by title. If ambiguous (multiple matches), present a short numbered list and ask the user to pick one.
   - If nothing is provided, ask the user for an action item name or ID.
   - If no match is found, output: `✗ No action item found matching: {input}`
   - **CRITICAL:** Once resolved, store the **complete UUID** (e.g. `f43c187c-23e0-4764-885f-ef3a733d08df`) in working memory as `resolved_action_item_id`. Never truncate, pad, or reconstruct this value — always use the exact string returned by the API.

2. **Load context.** Once resolved, call in parallel:
   - `get_action_item_history(action_item_id)` — prior notes, commits, lifecycle changes
   - `search_memories({ project_id, query: "<action item title>" })` — related decisions, conventions, risks

3. **Present the item.** Output a compact summary:
   ```
   ━━━ Brainstorm ━━━
   Title:    {title}
   ID:       {first 8 chars of id}  (display only — full UUID stored in working memory)
   Type:     {type}
   Lifecycle: {lifecycle}
   Priority: {priority or "not set"}
   ──────────────────
   {description or "No description"}
   ━━━━━━━━━━━━━━━━━━
   ```
   If there are prior implementation notes or related memories, mention them briefly (e.g., "2 prior notes, 1 related decision").

4. **Brainstorming loop.** Ask questions in **rounds of 5**, drawn from this taxonomy (pick the most impactful gaps first):

   **Scope & Intent**
   - What is the core problem this solves? Who benefits?
   - What is explicitly out of scope?

   **Approach & Alternatives**
   - What implementation strategies exist? Tradeoffs?
   - Are there existing patterns in the codebase to follow or avoid?

   **Data & State**
   - What data changes, migrations, or new entities are needed?
   - What state transitions or side effects are involved?

   **Edge Cases & Failure Modes**
   - What happens when inputs are invalid or missing?
   - What are the concurrency, rate-limit, or timeout concerns?

   **Dependencies & Integration**
   - What other systems, APIs, or action items does this depend on?
   - What will break or need updating downstream?

   **Acceptance & Verification**
   - How do we know this is done? What does a tester verify?
   - What metrics or logs should confirm success?

   For each question:
   - **Analyze the context** and provide a recommended answer with brief reasoning.
   - Format: `**Suggested:** <your proposal> — <1-sentence reasoning>`
   - Then ask: `Agree, adjust, or provide your own answer.`
   - If the user replies "yes", "agree", or "suggested", accept your proposal.
   - If the user says "skip", move to the next question.
   - Record each accepted answer in working memory.

   **After each round of 5 questions:**
   - If you believe all high-impact areas have been covered and there are no remaining meaningful questions to ask, end the loop automatically and tell the user: `All key areas covered — wrapping up brainstorm.`
   - Otherwise, ask: `Continue brainstorming? (y/n)`
     - If **yes**: ask another round of up to 5 questions, continuing from the taxonomy areas not yet covered or diving deeper into areas that need more exploration.
     - If **no**: end the loop.
   - This continues indefinitely until the user declines or all areas are exhausted.

   **Early exit:** At any point during a round, if the user signals done ("done", "good", "that's it", "stop"), end the loop immediately.

5. **Compile brainstorm summary.** After the loop, synthesize all accepted answers into a structured markdown note:

   ```markdown
   ## Brainstorm Summary

   **Scope:** <1-2 sentences>
   **Approach:** <chosen strategy + key tradeoffs>
   **Edge Cases:** <bullet list of identified risks>
   **Acceptance Criteria:** <bullet list of verifiable conditions>
   **Open Questions:** <anything unresolved, if any>
   ```

   Present this summary to the user.

6. **Save to DevSpec.** Ask: `Save this brainstorm to the action item in DevSpec?`
   - If yes: call `add_implementation_note(action_item_id: <resolved_action_item_id>, content: <compiled summary>)`. Use markdown formatting — headers, bullet lists, **bold** for key decisions, `code` for technical terms.
     Use the **full UUID** from `resolved_action_item_id` stored in step 1 — never reconstruct or pad the ID.
     Then output:
     ```
     ✓ Brainstorm saved
       Item:  {first 8 chars of id} — {title}
       Note:  {note_id or "linked"}
     ```
   - If no: output `↻ Brainstorm not saved — summary is above if you need it later.`

7. **Persist durable conclusions.** If the brainstorm settled something durable about the *project itself* — a decision, convention, architecture fact, or risk that outlives this item — record it to DevSpec with `record_memory` (`decision`/`convention`/`architecture`/`risk`/`insight`). `search_memories` FIRST and `supersede_memory`/`retract_memory` the stale match instead of duplicating; record shared knowledge only, not transient or obvious details. DevSpec memory is the team's **shared** source of truth, so don't let a durable conclusion be lost or kept only in your own local notes (OpenCode's `AGENTS.md` / instructions file), where personal or machine-specific notes belong.

## Rules

- Do NOT output filler text before or after structured output
- Keep questions sharp and specific to the action item — no generic prompts
- Never reveal the full question queue in advance
- If the action item already has rich context (detailed description, many notes), focus questions on gaps rather than re-covering known ground
- Respect early termination signals from the user
- Questions are asked in rounds of 5 — no hard cap on total questions
