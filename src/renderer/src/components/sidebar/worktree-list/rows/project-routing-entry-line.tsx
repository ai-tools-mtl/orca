import React, { useCallback, useMemo, useState } from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'
import { getVirtualRowTransform } from '../viewport/virtual-rows'
import RoutingEntryCard from '../../workspace-card/activity/RoutingEntryCard'
import { useRoutingEntryFacts } from '../../workspace-card/activity/use-routing-entry-facts'

// The project's standing 统一任务入口 row (plan §1/§9-A): every request for this project is
// recorded here and its sub-actions fan out beneath it. Facts and actions go to the desktop
// entry's own runtime methods (orchestration.entry*) — no terminal or session authority.

export default function ProjectRoutingEntryLine({
  repoId,
  hostId
}: {
  repoId: string
  hostId: ExecutionHostId
}): React.JSX.Element {
  const t = useTranslate()
  const target = useMemo(() => ipcOrRuntimeTargetForHostId(hostId), [hostId])
  const facts = useRoutingEntryFacts(target, repoId)
  const [draft, setDraft] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)

  const submit = useCallback(() => {
    const text = draft.trim()
    if (!text) {
      return
    }
    void facts.submit(text).then(() => setDraft(''))
  }, [draft, facts])

  const sendSupplement = useCallback(
    (subActionId: string, text: string) => {
      const owner = facts.inputs.find((input) =>
        input.subActions.some((subAction) => subAction.subActionId === subActionId)
      )
      const dispatch = facts.inputs
        .flatMap((input) => input.subActions)
        .find((subAction) => subAction.subActionId === subActionId)?.claimedBy
      if (!owner || !dispatch) {
        setSubmitError(
          t(
            'auto.components.sidebar.RoutingEntryCard.noSendTarget',
            'No execution target: claim a Dispatch first, or keep exactly one active worker here.'
          )
        )
        return
      }
      setSubmitError(null)
      void facts.sendSupplement(owner.inputId, subActionId, dispatch, text)
    },
    [facts, t]
  )

  return (
    <div className="flex flex-col gap-1 px-2 pb-1.5">
      <div className="flex items-center gap-1">
        <input
          value={draft}
          placeholder={t(
            'auto.components.sidebar.RoutingEntryCard.composerPlaceholder',
            'Describe a request for this project'
          )}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              submit()
            }
          }}
          className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button variant="outline" size="sm" disabled={facts.busy || !draft.trim()} onClick={submit}>
          {t('auto.components.sidebar.RoutingEntryCard.send', 'Send')}
        </Button>
      </div>
      {(submitError ?? facts.error) ? (
        <p className="text-xs text-destructive">{submitError ?? facts.error}</p>
      ) : null}
      <RoutingEntryCard
        paused={facts.paused}
        busy={facts.busy}
        inputs={facts.inputs}
        onRefresh={() => void facts.refresh()}
        onHandback={(subActionId, dispatchId) => void facts.handback(subActionId, dispatchId)}
        onSendSupplement={sendSupplement}
      />
    </div>
  )
}

export function renderProjectRoutingEntryVirtualRow(args: {
  row: Extract<Row, { type: 'project-routing-entry' }>
  vItem: VirtualItem
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
}): React.JSX.Element {
  return (
    <div
      role="presentation"
      data-worktree-virtual-row
      data-worktree-virtual-row-key={String(args.vItem.key)}
      data-worktree-virtual-row-start={args.vItem.start}
      data-index={args.vItem.index}
      ref={args.measureVirtualRowElement}
      className="absolute left-0 right-0 top-0"
      style={{ transform: getVirtualRowTransform(args.vItem.start) }}
    >
      <ProjectRoutingEntryLine repoId={args.row.repoId} hostId={args.row.hostId} />
    </div>
  )
}
