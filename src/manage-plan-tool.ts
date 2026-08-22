import { tool, type ToolDefinition } from '@opencode-ai/plugin'
import { mcpToolsCall } from './devspec-client.js'
import { resolveDevspecAuth } from './resolve-devspec-auth.js'

export const CONNECTION_CAPABILITY_VERSION = 1 as const
export const IMPLEMENTATION_CONTRACT_URI = 'devspec://product/implementation-contract'

const capabilities = new Map<string, string>()
const READ_ACTIONS = new Set(['list', 'get'])

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function capabilityAt(value: unknown): string | null {
  if (!record(value)) return null
  const devspec = record(value.devspec) ? value.devspec : null
  const capability = devspec && record(devspec.connection_capability)
    ? devspec.connection_capability
    : null
  return capability?.version === CONNECTION_CAPABILITY_VERSION &&
    typeof capability.value === 'string' && capability.value.startsWith('dvsc_')
    ? capability.value
    : null
}

/**
 * Capture only the MCP result metadata paths OpenCode exposes to the plugin.
 * Model-visible content is deliberately never searched for a capability-shaped
 * string, so a tool response or command body cannot spoof connection identity.
 */
export function captureConnectionCapability(sessionId: string, hookOutput: unknown): boolean {
  if (!sessionId || !record(hookOutput)) return false
  const candidates = [
    hookOutput._meta,
    hookOutput.metadata,
    record(hookOutput.metadata) ? hookOutput.metadata._meta : null,
  ]
  const capability = candidates.map(capabilityAt).find((value): value is string => Boolean(value))
  if (!capability) return false
  capabilities.set(sessionId, capability)
  return true
}

/** Capture raw MCP result `_meta` supplied directly by the trusted HTTP client. */
export function captureConnectionCapabilityMeta(sessionId: string, meta: unknown): boolean {
  if (!sessionId) return false
  const capability = capabilityAt(meta)
  if (!capability) return false
  capabilities.set(sessionId, capability)
  return true
}

export function hasConnectionCapability(sessionId: string): boolean {
  return capabilities.has(sessionId)
}

/** Trusted host transport accessor; never expose its return value to a model. */
export function connectionCapabilityForTransport(sessionId: string): string | null {
  return capabilities.get(sessionId) ?? null
}

export function clearConnectionCapability(sessionId?: string): void {
  if (sessionId) capabilities.delete(sessionId)
  else capabilities.clear()
}

/** Preserve the same connection identity across an intentional in-place context wipe. */
export function moveConnectionCapability(fromSessionId: string, toSessionId: string): void {
  const capability = capabilities.get(fromSessionId)
  capabilities.delete(fromSessionId)
  if (capability) capabilities.set(toSessionId, capability)
}

/** Mechanical registration negotiation; caller identity never becomes a model argument. */
export function negotiateConnectionCapability(args: unknown): void {
  if (!record(args)) return
  args.connection_capability_version = CONNECTION_CAPABILITY_VERSION
}

export function createManagePlanTool(directory: string): ToolDefinition {
  const z = tool.schema
  const step = z.object({
    id: z.string().uuid().optional(),
    title: z.string().min(1),
    description: z.string().min(1).optional(),
  })

  return tool({
    description:
      `Manage the authenticated connection's shared session plan. Read ${IMPLEMENTATION_CONTRACT_URI} ` +
      'to decide when tracking is warranted. Caller identity/session are capability-derived, never arguments. ' +
      'Existing-plan mutations require expected_revision; explicit plan_id marks intentional cross-plan targeting. ' +
      'advance completes the current milestone, optionally amends, and starts the next atomically. ' +
      'adopt is limited server-side to an orphaned same-owner plan in this session.',
    args: {
      action: z.enum([
        'create',
        'list',
        'get',
        'update',
        'start_step',
        'complete_step',
        'skip_step',
        'fail_step',
        'advance',
        'complete',
        'abandon',
        'adopt',
      ]),
      plan_id: z.string().uuid().optional(),
      expected_revision: z.number().int().positive().optional(),
      title: z.string().min(1).optional(),
      steps: z.array(step).max(50).optional(),
      step_id: z.string().uuid().optional(),
      current_step_id: z.string().uuid().optional(),
      next_step_id: z.string().uuid().optional(),
      reason: z.string().min(1).optional(),
      retryable: z.boolean().optional(),
    },
    async execute(args, context) {
      const capability = capabilities.get(context.sessionID)
      if (!capability) {
        throw new Error(
          'DevSpec manage_plan is unavailable until this OpenCode session registers its connection capability. ' +
            'Run /devspec.remote (or register_connection) in this session, then retry.',
        )
      }
      if (!READ_ACTIONS.has(args.action)) {
        await context.ask({
          permission: 'devspec_manage_plan',
          patterns: [args.action],
          always: [],
          metadata: { action: args.action },
        })
      }
      const auth = resolveDevspecAuth(context.directory || directory)
      if (!auth.ok || !auth.token || !auth.mcp_url) {
        throw new Error(auth.error || 'DevSpec MCP authentication is unavailable')
      }
      const result = await mcpToolsCall({
        mcpUrl: auth.mcp_url,
        token: auth.token,
        name: 'manage_plan',
        arguments: args,
        connectionCapability: capability,
        signal: context.abort,
      })
      return JSON.stringify(result, null, 2)
    },
  })
}
