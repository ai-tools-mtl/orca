import type { AgentSessionExpectedSteerOutcome, SteerExpectedTurnInput } from '../../native-chat/agent-session-wire/providers/structured-agent-session-expected-steer'
import { providerDiagnostic } from '../../../shared/agent-session/failures/agent-session-failure'
import type { ClaudeSession } from './claude-structured-session-state'
import { dispatchClaudeTurn } from './claude-structured-dispatch'

/** Targeted delivery for Claude: the send rides the open turn as a priority `now` message, so the
 *  running step hands the turn to it. The named open turn must be the running one, or this refuses
 *  without writing — a plain send here would start a new turn instead. */
export async function steerExpectedClaudeTurn(
  session: ClaudeSession,
  input: SteerExpectedTurnInput
): Promise<AgentSessionExpectedSteerOutcome> {
  const translator = session.translator
  if (!translator || !translator.openTurnHasInputWork || translator.currentTurnId !== input.expectedTurnId) {
    return { status: 'refused', kind: 'turn-not-active', expectedTurnId: input.expectedTurnId }
  }
  const outcome = await dispatchClaudeTurn(session, input, async () => ({ steers: true }))
  if (outcome.state === 'accepted' || outcome.state === 'admitted') {
    return { status: 'delivered', turnId: input.expectedTurnId, via: 'steer' }
  }
  if (outcome.state === 'rejected') {
    return {
      status: 'refused',
      kind: 'provider-refused',
      expectedTurnId: input.expectedTurnId,
      detail: providerDiagnostic(outcome.reason, 'log') ?? undefined
    }
  }
  return {
    status: 'refused',
    kind: 'provider-refused',
    expectedTurnId: input.expectedTurnId,
    detail: providerDiagnostic(outcome.reason, 'log') ?? undefined
  }
}
