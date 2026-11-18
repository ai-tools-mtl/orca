import type {
  AgentSessionExpectedSteerOutcome,
  SteerExpectedTurnInput
} from '../../native-chat/agent-session-wire/providers/structured-agent-session-expected-steer'
import { acpDispatchPrompt } from './acp-prompt-content'
import type { AcpStructuredSession } from '../session/acp-structured-session-contract'

/** Targeted delivery for ACP agents: with the agent's own prompt running, `turns.dispatch` queues
 *  the send as a steer into that open turn; without it the same call would start a new turn, which
 *  targeted delivery never does — so the named open turn must be provably the running one. */
export async function steerExpectedAcpTurn(
  session: AcpStructuredSession,
  input: SteerExpectedTurnInput,
  now: () => number
): Promise<AgentSessionExpectedSteerOutcome> {
  if (!session.turns.running || session.lane.openTurnId !== input.expectedTurnId) {
    return { status: 'refused', kind: 'turn-not-active', expectedTurnId: input.expectedTurnId }
  }
  const prompt = await acpDispatchPrompt(input.body, session)
  if (!Array.isArray(prompt)) {
    return {
      status: 'refused',
      kind: 'provider-refused',
      expectedTurnId: input.expectedTurnId,
      detail: { text: prompt.reason, audience: 'log' }
    }
  }
  session.turns.dispatch({
    clientMessageId: input.clientMessageId,
    prompt,
    requestedAt: now()
  })
  return { status: 'delivered', turnId: input.expectedTurnId, via: 'steer' }
}
