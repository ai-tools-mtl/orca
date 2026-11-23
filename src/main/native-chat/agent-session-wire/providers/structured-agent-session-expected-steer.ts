import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { ProviderDiagnostic } from '../../../../shared/agent-session/failures/agent-session-failure'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

/** Targeted delivery steers one named turn; refusals are typed facts bound to that turn, never re-targets. */
export type AgentSessionExpectedSteerOutcome =
  | { status: 'delivered'; turnId: string; via: 'steer' }
  | {
      status: 'refused'
      /** turn-not-active: the execution record shows the named turn is gone; provider-refused: the
       *  provider declined the steer by name; unsupported: this adapter has no targeted delivery. */
      kind: 'turn-not-active' | 'provider-refused' | 'unsupported'
      expectedTurnId: string
      detail?: ProviderDiagnostic
    }

/** One targeted steer: exactly `expectedTurnId`, no admission, no re-targeting. */
export type SteerExpectedTurnInput = {
  sessionId: string
  clientMessageId: string
  body: AgentJournalMessageItem
  expectedTurnId: string
  signal?: AbortSignal
  isCurrent?: () => boolean
}

/** Route a targeted steer through the host's adapter; adapters without it refuse as unsupported. */
export async function steerExpectedTurnViaAdapter(
  adapter: StructuredAgentSessionAdapter,
  input: SteerExpectedTurnInput
): Promise<AgentSessionExpectedSteerOutcome> {
  const steer = adapter.steerExpectedTurn
  if (!steer) {
    return { status: 'refused', kind: 'unsupported', expectedTurnId: input.expectedTurnId }
  }
  return steer(input)
}

/** The router's default when the owning adapter has no targeted steer: refuse as unsupported. */
export function unsupportedSteerOutcome(input: {
  expectedTurnId: string
}): AgentSessionExpectedSteerOutcome {
  return { status: 'refused', kind: 'unsupported', expectedTurnId: input.expectedTurnId }
}
