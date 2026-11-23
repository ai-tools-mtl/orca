import React, { useMemo, useState } from 'react'
import { cn } from '@/lib/class-names'
import { DispatchWorktreesPortal } from '@/components/right-sidebar/dispatch-worktrees/dispatch-worktrees-portal'
import {
  NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
  NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS,
  nativeChatTranscriptOuterClass
} from '@/components/native-chat/appearance/native-chat-appearance-style'
import { Sparkles } from 'lucide-react'
import { EntryToolbar, type EntryView } from './entry-toolbar'
import { EntryWorktreePreview } from './entry-worktree-preview'
import { EntryWorkerApproval } from './entry-worker-approval'
import { DispatchEntryComposer } from './dispatch-entry-composer'
import { EntryInputRow } from './entry-input-row'
import { EntryBoardView } from './entry-board-view'
import { entryTaskFactsOf, type EntryTaskFact } from './entry-task-facts'
import { EntryTimelineDays } from './entry-timeline-days'
import { EntryTimelineViewport } from './entry-timeline-viewport'
import { useEntryTimeline } from './use-entry-timeline'
import { entryTimelineEventsOf } from './entry-timeline-events'
import { EntryTimelineActivity } from './entry-timeline-activity'
import { EntryTimelinePending } from './entry-timeline-pending'
import { locateEntryTimelineCard } from './entry-task-view'
import { useEntryCardActions } from './use-entry-card-actions'
import { useEntryResultReadState } from './use-entry-result-read-state'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import type { EntryDeleteRequest } from '../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type {
  RoutingEntryApproval,
  RoutingEntrySubAction
} from '../workspace-card/activity/routing-entry-model'
import { useRoutingEntryFacts } from '../workspace-card/activity/use-routing-entry-facts'
import { useEntryAskMode } from './use-entry-ask-mode'
import { useEntryGateMode } from './use-entry-gate-mode'
import { useEntryAgents } from './use-entry-agents'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

export default function DispatchEntryChat({
  repoId,
  hostId,
  repoDisplayName,
  sidebarViewport,
  onWorkspaceOpened,
  reserveCollapsedSidebarHeaderSpace,
  headerAction
}: {
  repoId: string
  hostId: ExecutionHostId
  repoDisplayName: string
  sidebarViewport?: HTMLDivElement | null
  onWorkspaceOpened: () => void
  reserveCollapsedSidebarHeaderSpace: boolean
  headerAction?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const target = useMemo(() => ipcOrRuntimeTargetForHostId(hostId), [hostId])
  const facts = useRoutingEntryFacts(target, repoId)
  const projectKey = JSON.stringify([hostId, repoId])
  const automatic = useAppStore(
    (state) => state.settings?.dispatchEntryAutoRoute?.[projectKey] ?? true
  )
  const [view, setView] = useState<EntryView>('timeline')
  const [preview, setPreview] = useState<{ worktreeId: string; filePath: string } | null>(null)
  const [savingMode, setSavingMode] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [routingHints, setRoutingHints] = useState<Record<string, string>>({})
  const [loopPending, setLoopPending] = useState(false)
  const { askCount, latestAsk, askMode, toggle: toggleAskMode } = useEntryAskMode(facts.inputs)
  const { gateCount, latestGate, gateMode, toggle: toggleGateMode } = useEntryGateMode(facts.inputs)
  const decisionModel = useAppStore((state) => state.settings?.decisionModel)
  const worktrees = useAppStore((state) => state.worktreesByRepo[repoId])
  const events = useMemo(
    () => entryTimelineEventsOf(facts.inputs, facts.approvals),
    [facts.inputs, facts.approvals]
  )
  const { days, hasEvents, latestResultId, scroll, width, appearance } = useEntryTimeline(
    events,
    view === 'timeline'
  )
  const { isUnread, markSeen } = useEntryResultReadState(projectKey, setActionError)

  function locateEvent(id: string, read?: RoutingEntrySubAction): void {
    window.requestAnimationFrame(() => {
      if (locateEntryTimelineCard(scroll.streamRef.current, id) && read) {
        markSeen(read)
      }
    })
  }

  const cardActionsOf = useEntryCardActions({
    facts,
    target,
    worktrees,
    hostId,
    isUnread,
    markSeen,
    locateEvent,
    onWorkspaceOpened,
    onActionError: setActionError
  })

  const agents = useEntryAgents(facts, (message) => setActionError(message))

  async function routeInput(inputId: string, dispatch: boolean) {
    setRoutingHints((current) => ({ ...current, [inputId]: '' }))
    try {
      const result = await facts.autoRoute(inputId, dispatch)
      const hint = result.routed ? result.dispatchErrors?.join('\n') : result.reason
      if (hint) {
        setRoutingHints((current) => ({ ...current, [inputId]: hint }))
      }
    } catch (error) {
      setRoutingHints((current) => ({ ...current, [inputId]: String(error) }))
    }
  }

  function deleteInstructions(request: EntryDeleteRequest): void {
    setActionError(null)
    void facts.deleteInstructions(request).catch((cause: unknown) => {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const canDeleteFailed = facts.inputs.some((input) => input.canDeleteFailed)
  const approvalByDispatch = new Map(
    facts.approvals.toReversed().map((approval) => [approval.dispatchId, approval])
  )
  const worktreeNameOf = (worktreeId: string | null | undefined): string | undefined =>
    worktreeId ? worktrees?.find((worktree) => worktree.id === worktreeId)?.displayName : undefined
  const taskFacts = entryTaskFactsOf(
    facts.inputs,
    approvalByDispatch,
    facts.reviews,
    worktreeNameOf
  )

  function answerApproval(approval: RoutingEntryApproval, decision: 'allow' | 'deny'): void {
    void facts
      .answerApproval(
        approval.dispatchId,
        approval.approvalId,
        decision,
        approval.interrupted && decision === 'allow' ? true : undefined
      )
      .catch((error: unknown) => setActionError(String(error)))
  }

  function renderApproval(
    approval: RoutingEntryApproval,
    context?: React.ReactNode
  ): React.JSX.Element {
    return (
      <EntryWorkerApproval
        approval={approval}
        context={context}
        busy={facts.busy}
        paused={facts.paused}
        onAnswer={(decision) => answerApproval(approval, decision)}
      />
    )
  }

  function onTaskSelect({ subActionId }: Pick<EntryTaskFact, 'subActionId'>): void {
    setView('timeline')
    locateEvent(`entry-task-${subActionId}`)
  }

  return (
    <div
      className={cn(NATIVE_CHAT_APPEARANCE_ROOT_CLASS, 'flex min-h-0 min-w-0 flex-1 flex-col')}
      style={appearance}
      data-native-chat-scheme={appearance.colorScheme}
      data-dispatch-entry-chat=""
    >
      <DispatchWorktreesPortal
        viewport={sidebarViewport}
        repoId={repoId}
        hostId={hostId}
        facts={facts}
        onSelectTask={(subActionId) => onTaskSelect({ subActionId })}
        onPreviewFile={(worktreeId, filePath) => {
          setPreview({ worktreeId, filePath })
          setView('preview')
        }}
      />
      <EntryToolbar
        repoDisplayName={repoDisplayName}
        reserveCollapsedSidebarHeaderSpace={reserveCollapsedSidebarHeaderSpace}
        headerAction={headerAction}
        view={view}
        width={width}
        onViewChange={setView}
        previewAvailable={preview !== null}
        taskFacts={taskFacts}
        onTaskSelect={onTaskSelect}
        busy={facts.busy}
        automatic={automatic}
        savingMode={savingMode}
        onAutomaticChange={(checked) => {
          const state = useAppStore.getState()
          setSavingMode(true)
          setActionError(null)
          void state
            .updateSettingsOrThrow({
              dispatchEntryAutoRoute: {
                ...state.settings?.dispatchEntryAutoRoute,
                [projectKey]: checked
              }
            })
            .catch((error: unknown) => setActionError(String(error)))
            .finally(() => setSavingMode(false))
        }}
        onDeleteFailed={
          canDeleteFailed ? () => deleteInstructions({ group: repoId, scope: 'failed' }) : undefined
        }
        // 清空请求常驻：'all' 是 best-effort 清扫，无可清理时后端空结果不算错误。
        onClearAll={() => deleteInstructions({ group: repoId, scope: 'all' })}
      />
      {view === 'board' ? (
        <EntryBoardView facts={taskFacts} onSelect={onTaskSelect} />
      ) : view === 'preview' && preview ? (
        <EntryWorktreePreview
          key={`${preview.worktreeId}:${preview.filePath}`}
          worktreeId={preview.worktreeId}
          filePath={preview.filePath}
          onClose={() => {
            setPreview(null)
            setView('timeline')
          }}
        />
      ) : (
        <>
          <EntryTimelinePending
            events={events}
            reviews={facts.reviews}
            isUnread={isUnread}
            onSelect={locateEvent}
          />
          <EntryTimelineViewport scroll={scroll}>
            <div className={cn(nativeChatTranscriptOuterClass(false), 'pt-5')}>
              <div className={cn(NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS, 'gap-0')}>
                {facts.error ? (
                  <p className="mb-3 text-destructive text-xs">{facts.error}</p>
                ) : null}
                {actionError ? (
                  <p className="mb-3 text-destructive text-xs" role="alert">
                    {actionError}
                  </p>
                ) : null}
                {!hasEvents ? (
                  <div className="flex flex-col items-center gap-3.5 px-6 pt-20 pb-10 text-center text-muted-foreground">
                    <div className="grid size-11 place-items-center rounded-xl border bg-secondary">
                      <Sparkles className="size-5 text-ai-action-accent" />
                    </div>
                    <h2 className="text-sm font-semibold text-foreground">
                      {t(`${ENTRY}.emptyTitle`, 'Start work on this project')}
                    </h2>
                    <p className="max-w-[400px] text-xs leading-relaxed">
                      {t(
                        `${ENTRY}.emptyHint`,
                        'One message may contain several requests. It is saved first and shown as Received; routing splits the independent requests, dependent steps stay with one worker.'
                      )}
                    </p>
                  </div>
                ) : (
                  <EntryTimelineDays
                    days={days}
                    renderRow={(event, lastOfDay) => {
                      if (event.kind !== 'request') {
                        return (
                          <EntryTimelineActivity
                            key={event.id}
                            event={event}
                            showFullResult={event.id === latestResultId}
                            lastOfDay={lastOfDay}
                            busy={facts.busy}
                            isUnread={isUnread}
                            locate={locateEvent}
                            markSeen={markSeen}
                            answerAsk={facts.answerAsk}
                            grantGate={facts.gateGrant}
                            rejectGate={facts.gateReject}
                            renderApproval={renderApproval}
                            assignAgents={agents}
                            onAssignAgent={(inputId, subActionId, agent) => {
                              setActionError(null)
                              void facts
                                .assign(inputId, subActionId, agent)
                                .catch((error: unknown) => setActionError(String(error)))
                            }}
                            onActionError={setActionError}
                          />
                        )
                      }
                      const { input } = event
                      return (
                        <EntryInputRow
                          key={event.id}
                          input={input}
                          receivedAt={event.at}
                          lastOfDay={lastOfDay}
                          repoId={repoId}
                          facts={facts}
                          automatic={automatic}
                          agents={agents}
                          approvalByDispatch={approvalByDispatch}
                          routing={facts.routingInputs.has(input.inputId)}
                          hint={routingHints[input.inputId]}
                          onHint={(inputId, message) =>
                            setRoutingHints((current) => ({ ...current, [inputId]: message ?? '' }))
                          }
                          onRouteInput={(inputId, dispatch) => void routeInput(inputId, dispatch)}
                          onDelete={(subAction) =>
                            deleteInstructions(
                              subAction
                                ? {
                                    group: repoId,
                                    scope: 'sub-action',
                                    input: input.inputId,
                                    subAction
                                  }
                                : { group: repoId, scope: 'request', input: input.inputId }
                            )
                          }
                          onActionError={setActionError}
                          cardActions={cardActionsOf}
                        />
                      )
                    }}
                  />
                )}
              </div>
            </div>
          </EntryTimelineViewport>
          <DispatchEntryComposer
            busy={facts.busy || savingMode}
            mode={
              askMode && latestAsk
                ? { kind: 'ask', messageId: latestAsk.messageId }
                : gateMode && latestGate
                  ? { kind: 'gate', subActionId: latestGate.subActionId }
                  : { kind: 'new' }
            }
            askCount={askCount}
            askMode={askMode}
            toggleAskMode={toggleAskMode}
            gateCount={gateCount}
            gateMode={gateMode}
            toggleGateMode={toggleGateMode}
            loopPending={loopPending}
            setLoopPending={setLoopPending}
            answerAsk={facts.answerAsk}
            gateReject={facts.gateReject}
            submit={facts.submit}
            decisionModel={decisionModel}
            routeInput={routeInput}
            automatic={automatic}
            onActionError={setActionError}
          />
        </>
      )}
    </div>
  )
}
