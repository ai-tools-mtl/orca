import { showAgentPaneUnavailable } from '@/components/terminal-pane/agent-status/stale-agent-row'
import { findTerminalHandleTarget } from '@/components/terminal-pane/links/handles/terminal-handle-links'
import { structuredSessionOpenFeedback } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import { openDesktopStructuredSessionInteraction } from '@/lib/agent-session/open/open-existing-structured-session'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { revealTerminalPane } from '@/lib/workspace/activation/reveal-terminal-pane'
import { executionHostIdForStructuredTarget } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useAppStore } from '@/store'
import { isStructuredWorkerHandle } from '../../../../../shared/orchestration/workers/structured-worker-handle'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RuntimeTerminalFocus } from '../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { RoutingEntryExecution } from '../workspace-card/activity/routing-entry-model'

export async function openEntrySession(
  target: RuntimeClientTarget,
  execution: Pick<RoutingEntryExecution, 'dispatchId' | 'terminalHandle'>
): Promise<boolean> {
  const handle = execution.terminalHandle
  const result = await openDesktopStructuredSessionInteraction(
    {
      kind: 'sender',
      party: {
        address: `dispatch:${execution.dispatchId}`,
        terminalHandle: handle && !isStructuredWorkerHandle(handle) ? handle : null,
        orcaSessionId: null
      },
      messageIds: []
    },
    {
      target,
      present: (opened) => {
        if (opened.kind !== 'failed') {
          return
        }
        if (opened.failure.surface === 'terminal') {
          showAgentPaneUnavailable()
        } else if (opened.failure.reason === 'gone') {
          structuredSessionOpenFeedback.gone()
        } else if (opened.failure.reason === 'unsupported') {
          structuredSessionOpenFeedback.hostCannotOpen()
        } else {
          structuredSessionOpenFeedback.unavailable()
        }
      }
    }
  )
  if (result.kind === 'opened') {
    const activated = activateAndRevealWorkspace(result.target.worktreeId, {
      executionHostId: executionHostIdForStructuredTarget(target),
      providesInitialSurface: true
    })
    if (activated === false) {
      structuredSessionOpenFeedback.unavailable()
    }
    return activated !== false
  }
  if (result.kind !== 'terminal') {
    return false
  }
  if (target.kind === 'environment') {
    // Paired terminals should focus in this renderer, without moving the host's own window.
    const pane = findTerminalHandleTarget(
      result.handle,
      useAppStore.getState(),
      target.environmentId
    )
    if (
      pane &&
      revealTerminalPane({ ...pane, executionHostId: executionHostIdForStructuredTarget(target) })
    ) {
      return true
    }
  } else {
    const { focus } = await callRuntimeRpc<{ focus: RuntimeTerminalFocus }>(
      target,
      'terminal.focus',
      { terminal: result.handle, navigation: 'host' }
    )
    if (focus.navigated) {
      return true
    }
  }
  showAgentPaneUnavailable()
  return false
}
