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
}

export async function mcpToolsCall({ mcpUrl, token, name, arguments: toolArgs }: McpToolCallArgs): Promise<unknown> {
  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name, arguments: toolArgs || {} },
  }

  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  })

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
