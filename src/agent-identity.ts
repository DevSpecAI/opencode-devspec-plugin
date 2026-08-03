/**
 * Single source of truth for THIS plugin's agent identity.
 *
 * Every DevSpec plugin has its own module like this one, in its own repo. They are
 * independent implementations — nothing here is copied from or to another plugin —
 * and `test/agent-identity.test.mjs` pins this value so it cannot drift.
 *
 * The agent name is a FIXED property of the plugin, not runtime state, an
 * LLM-passed arg, or a copied literal scattered across call sites. Every
 * register/heartbeat/mirror call imports AGENT_NAME and uses it as THE identity,
 * so the connection can never mislabel itself no matter what is in a stale local
 * state file. One line to change per plugin; impossible to drift.
 */
export const AGENT_NAME = 'OpenCode'
