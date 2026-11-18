import type { ZcodeAppServerConnection } from '../../app-server/zcode-app-server-connection-types'
import type { StructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'

// Fixed-policy bookkeeping asks: the answers never depend on session state. Call this after the
// session-owned asks (headers, credential cipher, prompts) — its final branch answers the
// unknown-method fallback. Returns false only for asks that carry session state.

/** Answers the session's static asks; false means the caller owns this ask. */
export function answerZcodeBookkeepingAsk(input: {
  connection: Pick<ZcodeAppServerConnection, 'respond' | 'respondWithError'>
  logger: StructuredAgentSessionLogger | undefined
  method: string
  id: number | string
}): boolean {
  const { connection, logger, method, id } = input
  if (method === 'session/requestRuntimePreferences') {
    connection.respond(id, {
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: false
    })
    return true
  }
  if (method === 'interaction/requestOfficialMcpAuthHeaders') {
    connection.respondWithError(id, -32000, 'official MCP auth is unavailable in Orca chats')
    return true
  }
  logger?.warn('zcode app-server sent an unknown request', {
    scope: 'zcode-request-unknown',
    method
  })
  connection.respondWithError(id, -32601, `Orca does not answer ${method}`)
  return true
}
