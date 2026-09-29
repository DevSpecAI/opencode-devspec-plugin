/**
 * Derive OpenCode `external_directory` allow rules from the user's
 * DevSpec repo-folder-map so multi-repo automations can touch sibling
 * checkouts without laptop-specific opencode.json hardcodes.
 *
 * Scope rules (deliberately narrow for SaaS):
 * - Never allow filesystem / drive roots or the user's home directory.
 * - With only one mapped folder, add nothing (single-repo stays inside cwd).
 * - Allow each mapped folder outside the launch cwd.
 * - When two+ mapped folders (including the launch folder) share a safe
 *   common ancestor, also allow that ancestor so `cd ..` / listing siblings
 *   works — still scoped to the user's chosen workspace parent, not the disk.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * @param {string} p
 * @returns {string}
 */
export function resolveAbsolute(p) {
  return path.resolve(p)
}

/**
 * Comparison key — Windows paths are case-insensitive; map entries often
 * disagree with launch cwd on drive-letter casing (`C:` vs `c:`).
 * @param {string} p
 */
export function pathKey(p) {
  const resolved = resolveAbsolute(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * OpenCode path patterns are literal + wildcards. Emit both separators on
 * Windows because permission prompts have been observed with backslashes
 * while docs examples use forward slashes.
 *
 * @param {string} absoluteDir
 * @returns {string[]}
 */
export function pathPatternVariants(absoluteDir) {
  const resolved = resolveAbsolute(absoluteDir)
  const variants = new Set([resolved])
  if (process.platform === 'win32') {
    variants.add(resolved.replace(/\\/g, '/'))
    variants.add(resolved.replace(/\//g, '\\'))
    // Also emit lowercased drive / path forms — OpenCode may canonicalize.
    variants.add(resolved.toLowerCase())
    variants.add(resolved.toLowerCase().replace(/\\/g, '/'))
  } else {
    variants.add(resolved.replace(/\\/g, '/'))
  }
  return [...variants]
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
export function isUnsafeAncestor(dir) {
  const resolved = resolveAbsolute(dir)
  const key = pathKey(resolved)
  const home = pathKey(os.homedir())
  const root = pathKey(path.parse(resolved).root)
  if (!resolved || key === root) return true
  if (key === home) return true
  // One level under home (e.g. ~/Projects) is still a broad tenant boundary;
  // require a deeper workspace parent before allowing the whole tree.
  const homeParent = pathKey(path.dirname(os.homedir()))
  if (key === homeParent) return true
  return false
}

/**
 * Longest common directory that contains every path. Returns null when
 * paths do not share a safe ancestor.
 *
 * @param {string[]} absolutePaths
 * @returns {string | null}
 */
export function commonAncestorDirectory(absolutePaths) {
  if (!absolutePaths.length) return null
  const resolved = absolutePaths.map((p) => resolveAbsolute(p))
  const split = resolved.map((p) => {
    const parts = p.split(/[/\\]+/).filter(Boolean)
    // Keep Windows drive as first segment (C:)
    if (process.platform === 'win32' && /^[A-Za-z]:$/.test(parts[0] || '')) {
      return parts
    }
    if (p.startsWith('/')) return ['', ...parts]
    return parts
  })

  const first = split[0]
  if (!first) return null
  const common = []
  for (let i = 0; i < first.length; i++) {
    const part = first[i]
    const partKey = process.platform === 'win32' ? part.toLowerCase() : part
    if (
      split.every((parts) => {
        const other = parts[i]
        if (other === undefined) return false
        return (process.platform === 'win32' ? other.toLowerCase() : other) === partKey
      })
    ) {
      common.push(part)
    } else break
  }
  if (!common.length) return null

  let ancestor
  if (common[0] === '') {
    ancestor = `/${common.slice(1).join('/')}` || '/'
  } else if (/^[A-Za-z]:$/.test(common[0])) {
    ancestor = `${common[0]}\\${common.slice(1).join('\\')}`
  } else {
    ancestor = common.join(path.sep)
  }
  ancestor = resolveAbsolute(ancestor)

  // Must be a strict ancestor of at least one path (not equal to a leaf repo).
  const ancestorKey = pathKey(ancestor)
  const isStrictAncestor = resolved.some((p) => {
    const pk = pathKey(p)
    if (pk === ancestorKey) return false
    return pk.startsWith(ancestorKey + '\\') || pk.startsWith(ancestorKey + '/')
  })
  if (!isStrictAncestor) return null
  if (isUnsafeAncestor(ancestor)) return null
  return ancestor
}

/**
 * True when `candidate` is the launch folder or lives inside it.
 * @param {string} launchFolder
 * @param {string} candidate
 */
export function isInsideOrSameFolder(launchFolder, candidate) {
  const base = pathKey(launchFolder)
  const other = pathKey(candidate)
  if (other === base) return true
  return other.startsWith(base + '\\') || other.startsWith(base + '/')
}

/**
 * @param {{ launchFolder: string, mappedFolders: string[] }} input
 * @returns {Record<string, 'allow'>}
 */
export function buildExternalDirectoryAllowFromMappedFolders({ launchFolder, mappedFolders }) {
  /** @type {Record<string, 'allow'>} */
  const rules = {}
  const launch = resolveAbsolute(launchFolder)
  const mapped = [...new Set((mappedFolders || []).map((p) => resolveAbsolute(p)).filter(Boolean))]
  // Dedupe case-insensitively on Windows so C:\a and c:\a count as one.
  const deduped = []
  const seen = new Set()
  for (const folder of mapped) {
    const key = pathKey(folder)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(folder)
  }

  if (deduped.length < 2) return rules

  const outside = deduped.filter((folder) => !isInsideOrSameFolder(launch, folder))
  for (const folder of outside) {
    for (const variant of pathPatternVariants(folder)) {
      rules[`${variant}/**`] = 'allow'
      rules[`${variant}/*`] = 'allow'
    }
  }

  // Include the launch folder so the common ancestor covers the whole map set.
  const ancestor = commonAncestorDirectory([launch, ...deduped])
  if (ancestor && !isInsideOrSameFolder(launch, ancestor)) {
    for (const variant of pathPatternVariants(ancestor)) {
      rules[`${variant}/**`] = 'allow'
      rules[`${variant}/*`] = 'allow'
    }
  }

  return rules
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function mappedFoldersFromRepoMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  /** @type {string[]} */
  const folders = []
  for (const value of Object.values(/** @type {Record<string, unknown>} */ (raw))) {
    if (typeof value === 'string' && value.trim()) folders.push(value.trim())
  }
  return folders
}

/**
 * @param {string} mapPath
 * @returns {Promise<string[]>}
 */
export async function loadMappedFolders(mapPath) {
  try {
    const raw = JSON.parse(await fs.readFile(mapPath, 'utf8'))
    return mappedFoldersFromRepoMap(raw)
  } catch {
    return []
  }
}

/**
 * Merge derived external_directory allows into an existing OPENCODE_PERMISSION
 * JSON string (object form). Caller-supplied deny/ask for a path still wins
 * when already present — we only fill missing keys.
 *
 * @param {string | undefined} existingJson
 * @param {Record<string, 'allow'>} externalDirectoryRules
 * @returns {string | null} JSON for OPENCODE_PERMISSION, or null when nothing to set
 */
export function mergeOpenCodePermissionEnv(existingJson, externalDirectoryRules) {
  const keys = Object.keys(externalDirectoryRules || {})
  if (!keys.length) {
    return existingJson && existingJson.trim() ? existingJson : null
  }

  /** @type {Record<string, unknown>} */
  let base = {}
  if (existingJson && existingJson.trim()) {
    try {
      const parsed = JSON.parse(existingJson)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = /** @type {Record<string, unknown>} */ (parsed)
      }
    } catch {
      // Ignore unparsable existing value; replace with derived rules.
      base = {}
    }
  }

  const existingExternal = base.external_directory
  /** @type {Record<string, unknown>} */
  let external = {}
  if (existingExternal && typeof existingExternal === 'object' && !Array.isArray(existingExternal)) {
    external = { .../** @type {Record<string, unknown>} */ (existingExternal) }
  } else if (typeof existingExternal === 'string') {
    // Whole-permission string ("allow"/"ask"/"deny") — leave it; do not
    // silently narrow or widen a deliberate global setting.
    return existingJson || null
  }

  for (const [pattern, action] of Object.entries(externalDirectoryRules)) {
    if (external[pattern] === undefined) external[pattern] = action
  }

  return JSON.stringify({ ...base, external_directory: external })
}

/**
 * @param {{ launchFolder: string, mapPath: string, env?: NodeJS.ProcessEnv }} input
 * @returns {Promise<{ env: NodeJS.ProcessEnv, externalDirectoryRules: Record<string, 'allow'>, mappedFolderCount: number }>}
 */
export async function buildOpenCodeLaunchEnv({ launchFolder, mapPath, env = process.env }) {
  const mappedFolders = await loadMappedFolders(mapPath)
  const externalDirectoryRules = buildExternalDirectoryAllowFromMappedFolders({
    launchFolder,
    mappedFolders,
  })
  const permission = mergeOpenCodePermissionEnv(env.OPENCODE_PERMISSION, externalDirectoryRules)
  /** @type {NodeJS.ProcessEnv} */
  const next = { ...env }
  if (permission) next.OPENCODE_PERMISSION = permission
  return {
    env: next,
    externalDirectoryRules,
    mappedFolderCount: mappedFolders.length,
  }
}
