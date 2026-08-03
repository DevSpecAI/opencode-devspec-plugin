#!/usr/bin/env node
/**
 * Identity is a fixed property of THIS plugin, and this test is what pins it.
 *
 * The DevSpec plugins are independent implementations — no file crosses a repo
 * boundary, and there is no sync tool that could regenerate this. OpenCode is the
 * furthest from the others anyway: remote control here is TypeScript in-process
 * (`src/remote-control.ts`), not a hook-script layer. The guarantee that used to
 * come from central generation lives here instead: same protection against item
 * `f99bc20b` (a plugin registering under another plugin's name), no cross-repo
 * copying.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { AGENT_NAME } from '../dist/agent-identity.js'

/** This repo's plugin. Changing this line is changing which plugin this is. */
const OWN_NAME = 'OpenCode'

/** Every other DevSpec plugin. None of these may appear as a literal in our source. */
const RIVAL_NAMES = ['Claude Code', 'Cursor', 'Grok Build', 'Antigravity', 'Codex']

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** Our TypeScript sources — the identity module itself excluded. */
function sourceFiles() {
  return fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith('.ts') && f !== 'agent-identity.ts')
    .sort()
}

describe('AGENT_NAME', () => {
  it('is this plugin, not another one', () => {
    assert.equal(AGENT_NAME, OWN_NAME)
  })

  it('is a non-empty, untrimmed-clean string', () => {
    assert.equal(typeof AGENT_NAME, 'string')
    assert.ok(AGENT_NAME.length > 0)
    assert.equal(AGENT_NAME, AGENT_NAME.trim())
  })
})

describe('no rival plugin name is hardcoded in this repo', () => {
  // The f99bc20b failure mode was a literal agent name sitting in the source — as a
  // fallback, a default, or (harmlessly at first) a usage example that later got
  // copied into real code. Catch the literal, wherever it sits.
  for (const file of sourceFiles()) {
    it(`${file} references no other plugin by name`, () => {
      const src = fs.readFileSync(path.join(SRC, file), 'utf8')
      for (const rival of RIVAL_NAMES) {
        for (const quoted of [`'${rival}'`, `"${rival}"`]) {
          assert.ok(
            !src.includes(quoted),
            `${file} contains the literal ${quoted}. Identity comes from AGENT_NAME — ` +
              `never a hardcoded name, not even in a comment or usage example.`,
          )
        }
      }
    })
  }

  it('actually scanned something', () => {
    assert.ok(sourceFiles().length > 0, 'no source files found — check the glob')
  })
})
