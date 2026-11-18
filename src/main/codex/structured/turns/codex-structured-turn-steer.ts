import {
  StructuredAgentSessionInputNotAdmitted,
  type StructuredAgentSessionAdmitFreshInput
} from '../../../native-chat/agent-session-wire/delivery/structured-agent-session-input-admission'
import type { CodexTurnHost } from './codex-structured-turn-contract'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionExpectedSteerOutcome } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { checkDispatchAuthority } from './codex-structured-dispatch-authority'
import { turnInputFor } from './codex-structured-message-options'
import { readCodexTurnId } from '../../app-server/codex-structured-thread-facts'
import { isCodexAppServerRequestError } from '../../app-server/codex-app-server-request-error'
import { isCodexAppServerUnsupportedError } from '../../app-server/codex-app-server-session'

type CodexTurnSteerInput = {
  clientMessageId: string
  body: AgentJournalMessageItem
  timeoutMs?: number
  signal?: AbortSignal
  isCurrent?: () => boolean
  onReply?: () => void
  admitFreshInput?: StructuredAgentSessionAdmitFreshInput
}

/** Explicit steering avoids pre-0.148 turn/start replies naming nonexistent turns; overrides wait for a start. */
export async function steerCodexTurn(
  host: CodexTurnHost,
  expectedTurnId: string,
  input: CodexTurnSteerInput
): Promise<{ turnId: string; via: 'steer' } | null> {
  try {
    return { via: 'steer' as const, ...(await sendCodexTurnSteer(host, expectedTurnId, input)) }
  } catch (error) {
    if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
      return null
    }
    throw error
  }
}

/** Targeted delivery steers exactly the turn its caller named; a refusal is a typed fact bound to
 *  that turn, and this entry never re-targets another turn nor starts one. */
export async function steerExpectedCodexTurn(
  host: CodexTurnHost,
  expectedTurnId: string,
  input: CodexTurnSteerInput
): Promise<AgentSessionExpectedSteerOutcome> {
  if (
    host.abortedTurnIds?.has(expectedTurnId) ||
    host.activeTurnIds?.has(expectedTurnId) === false
  ) {
    return { status: 'refused', kind: 'turn-not-active', expectedTurnId }
  }
  try {
    return {
      status: 'delivered',
      via: 'steer' as const,
      ...(await sendCodexTurnSteer(host, expectedTurnId, input))
    }
  } catch (error) {
    if (isCodexAppServerRequestError(error)) {
      return {
        status: 'refused',
        kind: 'provider-refused',
        expectedTurnId,
        ...(error.providerDiagnostic ? { detail: error.providerDiagnostic } : {})
      }
    }
    if (isCodexAppServerUnsupportedError(error)) {
      return { status: 'refused', kind: 'unsupported', expectedTurnId }
    }
    throw error
  }
}

async function sendCodexTurnSteer(
  host: CodexTurnHost,
  expectedTurnId: string,
  input: CodexTurnSteerInput
): Promise<{ turnId: string }> {
  try {
    checkDispatchAuthority(host, input.clientMessageId, input.signal, input.isCurrent)
    const enqueue = (mode: Parameters<Parameters<StructuredAgentSessionAdmitFreshInput>[0]>[0]) => {
      const state = host.permissions
      if (state && mode !== (state.appliedMode ?? state.acquiredMode)) {
        return { kind: 'acquire' as const, reason: 'permission' as const }
      }
      checkDispatchAuthority(host, input.clientMessageId, input.signal, input.isCurrent)
      host.dispatchEchoes.expect(
        input.clientMessageId,
        host.threadId,
        'steer',
        turnInputFor(host, input.body),
        expectedTurnId
      )
      return {
        kind: 'sent' as const,
        response: host.connection.request(
          'turn/steer',
          {
            threadId: host.threadId,
            expectedTurnId,
            clientUserMessageId: input.clientMessageId,
            input: turnInputFor(host, input.body)
          },
          { timeoutMs: input.timeoutMs, onReply: input.onReply }
        )
      }
    }
    const admission = input.admitFreshInput
      ? await input.admitFreshInput(enqueue, input.signal, 'steer')
      : enqueue(host.permissions?.appliedMode ?? host.permissions?.acquiredMode ?? 'ask')
    if (admission.kind !== 'sent') {
      host.dispatchEchoes.disarm(input.clientMessageId)
      throw new StructuredAgentSessionInputNotAdmitted(
        undefined,
        admission.kind === 'acquire' ? admission.reason : 'permission'
      )
    }
    const answer = await admission.response
    return { turnId: readCodexTurnId(answer) ?? expectedTurnId }
  } catch (error) {
    if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
      host.dispatchEchoes.disarm(input.clientMessageId)
    }
    throw error
  }
}
