/**
 * Fleet recipe — shared contract with apps/web/lib/cursor-handoff/fleet-recipe.ts
 * (brief ba6bd58e / item 32b51eea). Keep validation rules in sync.
 */

export const FLEET_RECIPE_TOOLS = ['cursor', 'opencode', 'pi']

export const FLEET_RECIPE_MAX_PER_TOOL = 8
export const FLEET_RECIPE_MAX_TOTAL = 24

/**
 * Default prompt for Start local agents / Warm fleet spawns when the signed
 * handoff carries no prompt (prompt_chars=0) and no per-tool session attach.
 * Bare sessionless Connect — Cursor skill form (item f053c2ed).
 *
 * Prefer {@link fleetRemotePromptForTool} so OpenCode/Pi get the same slash
 * shape as a single coding-agent launch (item f2fe858e).
 */
export const FLEET_DEFAULT_REMOTE_PROMPT = 'Run the `devspec.remote` skill.'

/**
 * Short session code for OpenCode/Pi attach (matches web shortSessionId).
 * @param {unknown} sessionId
 * @returns {string}
 */
export function shortSessionId(sessionId) {
  const id = String(sessionId ?? '').trim()
  if (!id) return ''
  return id.split('-')[0] || id
}

/**
 * Same remote prompt a single coding-agent launch would use for this tool.
 * Session present → attach (`--session`). Else → sessionless Connect.
 *
 * @param {string | null | undefined} tool
 * @param {string | null | undefined} sessionId
 * @returns {string}
 */
export function fleetRemotePromptForTool(tool, sessionId) {
  const short = shortSessionId(sessionId)
  const t = String(tool ?? '').trim()

  if (short) {
    // Mirror apps/web formatDevspecRemoteAttachCommand for fleet's one-prompt fan-out.
    if (t === 'cursor') {
      return (
        `Run the \`devspec.remote\` skill with this input: --session ${short} — ` +
        `attach to existing DevSpec session ${short} (do NOT create_session). ` +
        `Let the installed skill run register_connection/attach_connection and launch ` +
        `its persistent poll_connection listener; it owns command delivery, activity, and replies.`
      )
    }
    // OpenCode + Pi (and any future slash-skill tool): same as single OpenCode session launch.
    return `/devspec.remote --session ${short}`
  }

  if (t === 'opencode' || t === 'pi') {
    return '/devspec.remote'
  }
  return FLEET_DEFAULT_REMOTE_PROMPT
}

/**
 * Resolve the prompt written into each fleet spawn's launch prompt file.
 * Prefer a non-empty handoff prompt (e.g. web already signed attach); otherwise
 * the per-tool single-launch shape (session attach when sessionId is set).
 *
 * @param {string | null | undefined} promptText
 * @param {{ tool?: string | null, sessionId?: string | null }} [opts]
 * @returns {string}
 */
export function resolveFleetSpawnPrompt(promptText, opts = {}) {
  const trimmed = typeof promptText === 'string' ? promptText.trim() : ''
  if (trimmed) return trimmed
  return fleetRemotePromptForTool(opts.tool, opts.sessionId)
}

/**
 * @param {unknown} input
 * @returns {{ ok: true, recipe: Record<string, number>, total: number } | { ok: false, error: string, detail?: string }}
 */
export function validateFleetRecipe(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'empty' }
  }

  const raw = /** @type {Record<string, unknown>} */ (input)
  const keys = Object.keys(raw)
  if (keys.length === 0) return { ok: false, error: 'empty' }

  /** @type {Record<string, number>} */
  const recipe = {}
  let total = 0

  for (const key of keys) {
    if (!FLEET_RECIPE_TOOLS.includes(key)) {
      return { ok: false, error: 'unknown_tool', detail: key }
    }
    const value = raw[key]
    if (value === undefined || value === null || value === 0) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return { ok: false, error: 'invalid_count', detail: key }
    }
    if (value > FLEET_RECIPE_MAX_PER_TOOL) {
      return { ok: false, error: 'over_per_tool_cap', detail: key }
    }
    if (value >= 1) {
      recipe[key] = value
      total += value
    }
  }

  if (total < 1) return { ok: false, error: 'empty' }
  if (total > FLEET_RECIPE_MAX_TOTAL) return { ok: false, error: 'over_total_cap' }
  return { ok: true, recipe, total }
}

/**
 * @param {Record<string, number>} recipe
 * @returns {string[]}
 */
export function expandFleetRecipe(recipe) {
  /** @type {string[]} */
  const out = []
  for (const tool of FLEET_RECIPE_TOOLS) {
    const count = recipe[tool] ?? 0
    for (let i = 0; i < count; i++) out.push(tool)
  }
  return out
}

/**
 * Pull a validated recipe off a verified handoff payload (or null).
 * @param {Record<string, unknown> | null | undefined} data
 */
export function recipeFromHandoffPayload(data) {
  if (!data || data.recipe == null) return null
  const validated = validateFleetRecipe(data.recipe)
  return validated.ok ? validated.recipe : null
}

/**
 * Optional DevSpec session id on the handoff (fleet attach parity — item f2fe858e).
 * @param {Record<string, unknown> | null | undefined} data
 * @returns {string | null}
 */
export function sessionIdFromHandoffPayload(data) {
  if (!data) return null
  const raw = data.sessionId ?? data.session_id
  const id = typeof raw === 'string' ? raw.trim() : ''
  return id || null
}
