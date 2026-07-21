/**
 * Register this package's bundled commands/*.md files into OpenCode's
 * declarative `command` config, via the plugin `config` hook.
 *
 * Confirmed by installing the real OpenCode CLI and reading its own
 * built-in "customize-opencode" skill (`opencode debug skill`), then
 * verifying empirically with `opencode debug config`: OpenCode's command
 * loader ONLY scans `.opencode/command(s)/` (project) and
 * `~/.config/opencode/command(s)/` (global) — an installed plugin
 * package's own `commands/` directory is NOT auto-discovered the way
 * `instructions` file paths are. Shipping markdown files in `commands/`
 * alone (this package's original design) silently does nothing.
 *
 * The fix: `command` in `opencode.json` is itself just data
 * (`{ [name]: { template, description, ... } }`), and the plugin `config`
 * hook is handed the live merged config to mutate before startup
 * finishes. So this reads the same markdown files and injects them as
 * `cfg.command` entries at runtime — works regardless of where the
 * package is installed, no copying files into `.opencode/` required.
 *
 * Never overwrites a command name the user already defined themselves
 * (project/global config wins over the package default).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from '@opencode-ai/plugin'

type Config = Parameters<NonNullable<Awaited<ReturnType<Plugin>>['config']>>[0]

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** `dist/register-commands.js` -> package root -> `commands/`. */
const COMMANDS_DIR = path.join(HERE, '..', 'commands')

function parseCommandFile(content: string): { description?: string; template: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) return { template: content }
  const [, frontmatter, body] = match
  const descriptionMatch = frontmatter!.match(/^description:\s*(.+)$/m)
  return {
    description: descriptionMatch?.[1]?.trim(),
    template: body!.trimStart(),
  }
}

export function registerBundledCommands(cfg: Config): void {
  let files: string[]
  try {
    files = fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'))
  } catch {
    return // commands/ missing — nothing to register, not fatal
  }

  cfg.command ??= {}
  for (const file of files) {
    const name = file.slice(0, -3) // strip ".md" — matches the .opencode/command/<name>.md convention
    if (cfg.command[name]) continue // user's own project/global command wins
    const raw = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf8')
    const { description, template } = parseCommandFile(raw)
    cfg.command[name] = { template, description }
  }
}
