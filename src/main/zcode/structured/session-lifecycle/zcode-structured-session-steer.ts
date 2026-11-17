import type {
  AgentSessionExpectedSteerOutcome,
  SteerExpectedTurnInput
} from '../../../native-chat/agent-session-wire/providers/structured-agent-session-expected-steer'
import { providerDiagnostic } from '../../../../shared/agent-session/failures/agent-session-failure'
import type { ZcodeStructuredSession } from './zcode-structured-session'
import { readMessageText } from '../turns/zcode-message-text'

/**
 * Targeted delivery for ZCode: the backend queues `session/send` made while a turn runs and
 * delivers them as steer events into that open turn, so delivering into the named turn means
 * sending only while the lane's open turn is exactly the named one. The wire has no expected-turn
 * field — a turn that ends inside the check→send gap would accept the send as a new turn — so
 * misdelivery is caught post-hoc by the routing ledger's per-turn action attribution.
 */
export async function steerExpectedZcodeTurn(
  session: ZcodeStructuredSession,
  input: SteerExpectedTurnInput
): Promise<AgentSessionExpectedSteerOutcome> {
  if (session.lane?.openTurnId !== input.expectedTurnId) {
    return { status: 'refused', kind: 'turn-not-active', expectedTurnId: input.expectedTurnId }
  }
  const text = readMessageText(input.body)
  if (!text) {
    return {
      status: 'refused',
      kind: 'provider-refused',
      expectedTurnId: input.expectedTurnId,
      detail: providerDiagnostic('the supplement carries no text', 'log') ?? undefined
    }
  }
  session.dispatchPending = true
  try {
    const outcome = session.turns.dispatch({ clientMessageId: input.clientMessageId, text })
    if (outcome.state === 'admitted') {
      return { status: 'delivered', turnId: input.expectedTurnId, via: 'steer' }
    }
    return { status: 'refused', kind: 'provider-refused', expectedTurnId: input.expectedTurnId }
  } finally {
    session.dispatchPending = false
  }
}
