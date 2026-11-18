import type {
  AgentJournalAnsweredTurnIdentity,
  AgentJournalTurnItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalDispatchRejection } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'

export type StructuredAgentSessionCommandRun = {
  clientMessageId: string
  turnId: string
  identity: AgentJournalItemIdentity
  resultIdentity: AgentJournalItemIdentity
  running: AgentJournalTurnItem
  /** Only agents declaring `compactInstructions` receive this. */
  instructions?: string
}

/** Commands may answer in place without echoing provider items. */
export type AgentSessionCommandAdmission =
  | AgentSessionDispatchOutcome
  | { state: 'accepted'; providerIdentity: null }

/** Execution evidence only, never picker defaults; steers report their running turn’s choices. */
export type AgentSessionRanOptionsEvidence = { ranOptions?: Readonly<Record<string, string>> }

export type AgentSessionDispatchOutcome =
  | ({
      state: 'accepted'
      providerIdentity: AgentJournalItemIdentity
    } & AgentSessionRanOptionsEvidence)
  /** Transport admission stays pending until provider acknowledgement; elapsed time never proves unknown delivery. */
  | ({ state: 'admitted' } & AgentSessionRanOptionsEvidence)
  /** Generate rejection words with agentSessionFailureWords; answeredInTurn identifies an already-ended answering turn. */
  | ({
      state: 'rejected'
      answeredInTurn?: AgentJournalAnsweredTurnIdentity
    } & AgentJournalDispatchRejection)
  /** Unsettled calls never authorize automatic resend. */
  | { state: 'unknown'; reason: string }
