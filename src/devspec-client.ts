/**
 * Minimal JSON-RPC `tools/call` client against DevSpec's streamable-HTTP MCP
 * endpoint. Ported near-verbatim from claude-code-devspec-autopilot's
 * `hooks/scripts/mcp-call.mjs` — this piece is genuinely agent-agnostic
 * (plain fetch + JSON-RPC), no Claude Code specifics to translate.
 */

export interface McpToolCallArgs {
  mcpUrl: string
  token: string
  name: string
  arguments?: Record<string, unknown>
  /**
   * Client-side ceiling in ms. REQUIRED in spirit for `poll_connection`: that call is a
   * LONG-POLL the server holds open, and `fetch` has no default timeout, so a silently
   * dropped TCP connection would leave the pump awaiting a response that never comes —
   * no heartbeat, no delivery, and indistinguishable from "the owner sent nothing".
   * Omit for ordinary short calls.
   */
  timeoutMs?: number
  /** Abort the request from outside (plugin `dispose`, so a held poll cannot outlive the host). */
  signal?: AbortSignal
}

/** Thrown when a request exceeded its own `timeoutMs` (not a server error). */
export class McpTimeoutError extends Error {
  readonly timeoutMs: number
  constructor(name: string, timeoutMs: number) {
    super(`MCP ${name} exceeded its ${timeoutMs}ms client timeout`)
    this.name = 'McpTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export async function mcpToolsCall({
  mcpUrl,
  token,
  name,
  arguments: toolArgs,
  timeoutMs,
  signal,
}: McpToolCallArgs): Promise<unknown> {
  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name, arguments: toolArgs || {} },
  }

  // One controller for both reasons a request can be cut short: our own ceiling, and an
  // external abort (host shutdown). AbortSignal.any would be neater but is too new to
  // rely on across the Node/Bun runtimes OpenCode ships on.
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  let timedOut = false
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    // Never let our own ceiling keep the host process alive.
    timer.unref?.()
  }
  const onExternalAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  let res: Response
  try {
    res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    // Distinguish "we cut it off" from a genuine transport failure: a held poll timing
    // out is NORMAL (it means nothing arrived) and must not trigger error backoff.
    if (timedOut) throw new McpTimeoutError(name, timeoutMs as number)
    throw err
  } finally {
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onExternalAbort)
  }

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 400)}`)
  }

  let payload: any = null
  try {
    payload = JSON.parse(text)
  } catch {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data:')) {
        try {
          payload = JSON.parse(trimmed.slice(5).trim())
          break
        } catch {
          /* continue */
        }
      }
    }
  }

  if (!payload) {
    throw new Error(`Unparseable MCP response: ${text.slice(0, 200)}`)
  }
  if (payload.error) {
    throw new Error(payload.error.message || JSON.stringify(payload.error))
  }

  const content = payload.result?.content
  if (Array.isArray(content)) {
    const textParts = content
      .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
    const joined = textParts.join('\n')
    if (payload.result?.isError) {
      throw new Error(joined || 'MCP tool error')
    }
    try {
      return JSON.parse(joined)
    } catch {
      return { raw: joined, result: payload.result }
    }
  }
  return payload.result ?? payload
}
