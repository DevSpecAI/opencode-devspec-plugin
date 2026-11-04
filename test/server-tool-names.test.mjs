#!/usr/bin/env node
// Every DevSpec tool this plugin tells an agent to call must exist on the server.
//
// The skills, commands, hooks and docs name DevSpec tools, and nothing else checks
// those names against the server: retire or rename a tool there and this plugin
// keeps telling the agent to call it, which fails only at run time, in someone's
// session. This reads the live tool list from a devspecv2 checkout beside this
// repo and fails on any name the server does not have.
//
// With no checkout beside it the test skips, because CI has no pair. Name one
// with DEVSPEC_V2_ROOT; once named, it must be there.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const SELF = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SELF), '..')
const DEFINITIONS = 'apps/web/lib/mcp/tool-definitions.ts'

// Names the scan matches that are not DevSpec tools, each with the reason.
const NOT_DEVSPEC_TOOLS = new Map([])

// The connect path names both of these. A scan that misses them is broken, not clean.
const MUST_FIND = ['register_connection', 'poll_connection']

const NAME = '([a-z][a-z0-9]*(?:_[a-z0-9]+)+)'
// Each pattern says whether what it matches can only be a tool. A qualified name or a
// JSON-RPC call names a tool and nothing else. Prose is looser: "connect them via
// `parent_task_id`" reads exactly like "connect them via `link_tasks`", so a prose match
// may also be one of the server's argument names (item 2bfc7372, the Cursor plugin's
// rule from item ac7d624b) — but never a name the server has neither as a tool nor as
// an argument, so a retired or misspelt tool still fails.
const PATTERNS = [
  // A qualified name: mcp__plugin_devspec_devspec__<tool>, mcp__devspec__<tool>, devspec__<tool>.
  { toolOnly: true, re: new RegExp(`(?<![a-z0-9_])(?:mcp__[a-z0-9_]*?)?devspec(?:_devspec)?__${NAME}`, 'g') },
  // A JSON-RPC tools/call: name: '<tool>', arguments.
  { toolOnly: true, re: new RegExp(`name['"]?\\s*:\\s*['"]${NAME}['"]\\s*,\\s*['"]?arguments`, 'g') },
  // Prose that calls one: `<tool>(`.
  { toolOnly: true, re: new RegExp(`\`${NAME}\\(`, 'g') },
  // Prose that names one to use: call `<tool>`, use `<tool>`, via `<tool>`.
  { toolOnly: false, re: new RegExp(`\\b(?:[Cc]all|[Cc]alling|[Cc]alls|[Uu]se|[Uu]sing|[Vv]ia|[Rr]un|MCP)\\s+\`${NAME}\``, 'g') },
]
const SCANNED = /\.(md|mjs|cjs|js|mts|ts|json|toml|ya?ml)$/

/**
 * Every name the patterns find in `text`, and whether any match of it was tool-only.
 * @returns {Map<string, boolean>}
 */
function namesIn(text) {
  const found = new Map()
  for (const { toolOnly, re } of PATTERNS) {
    for (const match of text.matchAll(re)) found.set(match[1], (found.get(match[1]) ?? false) || toolOnly)
  }
  return found
}

/** A tool-only match must be a tool; a prose match may be a tool or an argument. */
function isKnown(name, toolOnly, server) {
  return server.tools.has(name) || (!toolOnly && server.params.has(name))
}

function serverCheckout() {
  const named = process.env.DEVSPEC_V2_ROOT?.trim()
  if (named) return { root: path.resolve(named), named: true }
  // The directories that hold this repo, nearest first. Only ever up, never a walk down.
  for (let dir = path.dirname(ROOT); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'devspecv2')
    if (fs.existsSync(path.join(candidate, DEFINITIONS))) return { root: candidate, named: false }
    if (path.dirname(dir) === dir) return { root: null, named: false }
  }
}

let serverTools = null
function serverToolList(root) {
  if (serverTools) return serverTools
  const tsx = path.join(root, 'node_modules/.bin/tsx')
  assert.ok(fs.existsSync(tsx), `${root} has no node_modules/.bin/tsx; run npm ci there`)
  const script = `import { getMcpAllTools } from ${JSON.stringify(path.join(root, DEFINITIONS))}
process.stdout.write(JSON.stringify(getMcpAllTools().map((tool) => ({
  name: tool.name,
  params: Object.keys(tool.inputSchema?.properties ?? {}),
}))))`
  const out = execFileSync(tsx, ['--tsconfig=apps/web/tsconfig.json', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  serverTools = JSON.parse(out)
  return serverTools
}

/** The server's tools, and every argument name any of them takes. */
function serverVocabulary(root) {
  const list = serverToolList(root)
  return {
    tools: new Set(list.map((tool) => tool.name)),
    params: new Set(list.flatMap((tool) => tool.params)),
  }
}

function referencedNames() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0')
  const found = new Map()
  for (const file of files) {
    // The changelog names retired tools on purpose: it is history.
    if (!SCANNED.test(file) || path.basename(file) === 'CHANGELOG.md') continue
    if (file.split('/').includes('node_modules')) continue
    const full = path.join(ROOT, file)
    if (full === SELF || !fs.existsSync(full)) continue
    const text = fs.readFileSync(full, 'utf8')
    for (const [name, toolOnly] of namesIn(text)) {
      const at = found.get(name) ?? { files: new Set(), toolOnly: false }
      at.files.add(file)
      at.toolOnly ||= toolOnly
      found.set(name, at)
    }
  }
  return found
}

function pairedServer(t) {
  const checkout = serverCheckout()
  if (checkout.root && fs.existsSync(path.join(checkout.root, DEFINITIONS))) return serverVocabulary(checkout.root)
  if (checkout.named) assert.fail(`DEVSPEC_V2_ROOT names ${checkout.root}, which has no ${DEFINITIONS}`)
  t.skip('no devspecv2 checkout beside this repo')
  return null
}

describe('DevSpec tools this plugin names', () => {
  it('are all tools the server has', (t) => {
    const server = pairedServer(t)
    if (!server) return
    const found = referencedNames()
    for (const name of MUST_FIND) assert.ok(found.has(name), `the scan did not find ${name}: it is broken, not clean`)
    const unknown = [...found]
      .filter(([name, at]) => !isKnown(name, at.toolOnly, server) && !NOT_DEVSPEC_TOOLS.has(name))
      .map(([name, at]) => `${name} (${[...at.files].sort().join(', ')})`)
    assert.deepEqual(unknown, [], `named here, but the server has no such tool:\n  ${unknown.join('\n  ')}`)
  })

  it('accept an argument named in prose, and still refuse a retired, misspelt or misused name', (t) => {
    const server = pairedServer(t)
    if (!server) return
    const unknownIn = (text) =>
      [...namesIn(text)].filter(([name, toolOnly]) => !isKnown(name, toolOnly, server)).map(([name]) => name)
    // Arguments the server takes, named the way the instructions name them.
    assert.deepEqual(unknownIn('connect them via `parent_task_id`, or use `companion_links`.'), [])
    // A tool the server retired, and a misspelling of a live one, in every shape.
    assert.deepEqual(unknownIn('call `update_action_item` to change it'), ['update_action_item'])
    assert.deepEqual(unknownIn('then `devspec__claim_work_items(` it'), ['claim_work_items'])
    assert.deepEqual(unknownIn('`get_next_work_item(task_id)`'), ['get_next_work_item'])
    // An argument is never a tool: a qualified call or a JSON-RPC call to one still fails.
    assert.deepEqual(unknownIn('`devspec__parent_task_id`'), ['parent_task_id'])
    assert.deepEqual(unknownIn(`{ name: 'companion_links', arguments: {} }`), ['companion_links'])
  })

  it('set aside only names that are still used and are still not DevSpec tools', (t) => {
    const server = pairedServer(t)
    if (!server) return
    const found = referencedNames()
    for (const name of NOT_DEVSPEC_TOOLS.keys()) {
      assert.ok(found.has(name), `${name} is set aside but nothing here names it any more; remove it`)
      assert.ok(!server.tools.has(name), `${name} is set aside but it is a DevSpec tool now; remove it so it is checked`)
    }
  })
})
