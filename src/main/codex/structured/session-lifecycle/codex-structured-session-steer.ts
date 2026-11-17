import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionExpectedSteerOutcome } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-expected-steer'
import { requireLiveCodexSession, type CodexSession } from './codex-structured-session-state'
import { steerExpectedCodexTurn } from '../turns/codex-structured-turn-steer'
import * as requestEndWait from '../turns/codex-request-end-wait'

/** Targeted delivery against a live Codex session: the same dispatchPending/settlement envelope a
 *  dispatch wraps its provider write in, around a strict named-turn steer. */
export async function steerExpectedCodexSessionTurn(
  sessions: ReadonlyMap<string, CodexSession>,
  input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    expectedTurnId: string
    signal?: AbortSignal
  }
): Promise<AgentSessionExpectedSteerOutcome> {
  const session = requireLiveCodexSession(sessions as Map<string, CodexSession>, input.sessionId)
  session.dispatchPending = true
  try {
    return await steerExpectedCodexTurn(session, input.expectedTurnId, {
      clientMessageId: input.clientMessageId,
      body: input.body,
      signal: input.signal,
      isCurrent: () => sessions.get(input.sessionId) === session
    })
  } finally {
    session.dispatchPending = false
    requestEndWait.settleCodexRequestEndWaiters(session)
  }
}
