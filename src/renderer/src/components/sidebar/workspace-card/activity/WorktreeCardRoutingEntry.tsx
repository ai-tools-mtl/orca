import { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { selectWorktreeAgentOrchestration } from './worktree-agent-orchestration-index'
import RoutingEntryCard from './RoutingEntryCard'
import { useRoutingEntryFacts } from './use-routing-entry-facts'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

type Props = {
  worktreeId: string
  executionHostId?: ExecutionHostId
}

/** The §9-A 统一任务入口 mounted on the workspace card: facts live in the runtime's routing
 *  ledger, reached through the run this workspace's orchestration panes belong to. Renders
 *  nothing until a run has recorded inputs (or the entry is paused) — no idle-card noise. */
export default function WorktreeCardRoutingEntry({ worktreeId, executionHostId }: Props) {
  const t = useTranslate()
  const runId = useAppStore(
    useShallow(
      (s) =>
        Object.values(selectWorktreeAgentOrchestration(s, worktreeId)).find(
          (context) => context.orchestrationRunId != null
        )?.orchestrationRunId
    )
  )
  const target = useMemo(() => ipcOrRuntimeTargetForHostId(executionHostId), [executionHostId])
  const facts = useRoutingEntryFacts(target, runId)
  const [sendError, setSendError] = useState<string | null>(null)

  const dispatchIds = useAppStore(
    useShallow((s) =>
      Object.values(selectWorktreeAgentOrchestration(s, worktreeId))
        .map((context) => context.dispatchId)
        .filter((id): id is string => id != null)
    )
  )
  // §5.2: exactly one valid execution target — an unclaimed sub-action may go to this
  // workspace's own Dispatch only when there is no ambiguity to guess across.
  const defaultDispatch = dispatchIds.length === 1 ? dispatchIds[0] : undefined

  const handback = useCallback(
    (subActionId: string, dispatchId: string) => {
      void facts.handback(subActionId, dispatchId)
    },
    [facts]
  )

  const sendSupplement = useCallback(
    (subActionId: string, text: string) => {
      const owner = facts.inputs.find((input) =>
        input.subActions.some((subAction) => subAction.subActionId === subActionId)
      )
      const dispatch =
        facts.inputs
          .flatMap((input) => input.subActions)
          .find((subAction) => subAction.subActionId === subActionId)?.claimedBy ?? defaultDispatch
      if (!owner || !dispatch) {
        setSendError(
          t(
            `${ENTRY}.noSendTarget`,
            'No execution target: claim a Dispatch first, or keep exactly one active worker here.'
          )
        )
        return
      }
      setSendError(null)
      void facts.sendSupplement(owner.inputId, subActionId, dispatch, text)
    },
    [facts, defaultDispatch, t]
  )

  if (!runId || (facts.inputs.length === 0 && !facts.paused)) {
    return null
  }
  return (
    <div onClick={(event) => event.stopPropagation()}>
      <RoutingEntryCard
        paused={facts.paused}
        busy={facts.busy}
        error={sendError ?? facts.error}
        inputs={facts.inputs}
        onRefresh={() => void facts.refresh()}
        onHandback={handback}
        onSendSupplement={sendSupplement}
      />
    </div>
  )
}
