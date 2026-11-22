import React, { useState } from 'react'
import { CircleAlert, CircleCheck, CircleDot, CircleMinus, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { cn } from '@/lib/class-names'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type {
  RoutingEntryApproval,
  RoutingEntryInput,
  RoutingEntrySubAction
} from '../workspace-card/activity/routing-entry-model'
import type { useRoutingEntryFacts } from '../workspace-card/activity/use-routing-entry-facts'
import { EntryDeleteButton } from './entry-delete-button'
import { EntryManualPlan } from './entry-manual-plan'
import { EntryClarifyList } from './entry-clarify-list'
import { EntryRouteCard } from './entry-route-card'
import { EntryTaskList } from './entry-task-list'
import type { EntryTaskActionHandlers } from './entry-task-card'
import { ENTRY_MESSAGE_SURFACE, EntryMessageHeader, EntryMessageText } from './entry-message'
import { entryCardStateOf } from './entry-task-view'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

export type EntryInputRowProps = {
  input: RoutingEntryInput
  repoId: string
  receivedAt?: Date
  facts: Pick<
    ReturnType<typeof useRoutingEntryFacts>,
    | 'busy'
    | 'savePlan'
    | 'assign'
    | 'reviews'
    | 'acceptReview'
    | 'handback'
    | 'transfer'
    | 'sendSupplement'
    | 'fetchWorkers'
  >
  automatic: boolean
  agents?: TuiAgent[]
  approvalByDispatch: ReadonlyMap<string, RoutingEntryApproval>
  routing: boolean
  hint?: string
  lastOfDay?: boolean
  onHint: (inputId: string, message: string | null) => void
  onRouteInput: (inputId: string, dispatch: boolean) => void
  onDelete: (subActionId?: string) => void
  onActionError: (message: string | null) => void
  cardActions: (action: RoutingEntrySubAction) => EntryTaskActionHandlers
}

export function EntryInputRow({
  input,
  repoId,
  receivedAt,
  facts,
  automatic,
  agents,
  approvalByDispatch,
  routing,
  hint: transientHint,
  lastOfDay,
  onHint,
  onRouteInput,
  onDelete,
  onActionError,
  cardActions
}: EntryInputRowProps): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [manualPlanOpen, setManualPlanOpen] = useState(false)
  const awaitingRoute = input.decisionStatus === 'received'
  const routingInProgress = awaitingRoute && routing
  const noWork = !awaitingRoute && input.subActions.length === 0
  const states = input.subActions.map((action) =>
    entryCardStateOf(
      action,
      Boolean(
        action.pausedAt ||
        action.pendingAsks?.length ||
        (action.execution && approvalByDispatch.has(action.execution.dispatchId))
      )
    )
  )
  const showChildDelete = !input.canDelete || input.subActions.length > 1
  const assignmentFailed = input.subActions.some((action) => action.assignmentFailed)
  const hint = routingInProgress
    ? undefined
    : (input.routingError ??
      (input.subActions.some((action) => action.assignmentError) ? undefined : transientHint))
  const failed = !noWork && (Boolean(hint) || assignmentFailed || states.includes('failed'))
  const attention = states.includes('attention')
  const complete = states.length > 0 && states.every((state) => state === 'done')
  const status = awaitingRoute
    ? routingInProgress
      ? t(`${ENTRY}.routingInProgress`, 'Routing…')
      : hint
        ? t(`${ENTRY}.routingFailed`, 'Routing failed')
        : t(`${ENTRY}.awaitingRouting`, 'Awaiting routing')
    : noWork
      ? t(`${ENTRY}.noDispatch`, 'No dispatch needed')
      : failed
        ? hint || assignmentFailed
          ? t(`${ENTRY}.dispatchFailed`, 'Dispatch failed')
          : t(`${ENTRY}.failedEvent`, 'Execution failed')
        : attention
          ? t(`${ENTRY}.workerAttention`, 'Needs attention')
          : complete
            ? t(`${ENTRY}.boardDone`, 'Done')
            : states.includes('working')
              ? t(`${ENTRY}.workerRunning`, 'Running')
              : t(`${ENTRY}.routeVerdict`, 'Dispatch decided')
  const StatusIcon = failed
    ? CircleAlert
    : noWork
      ? CircleMinus
      : complete
        ? CircleCheck
        : CircleDot
  const statusTone = failed
    ? 'bg-destructive/10 text-destructive'
    : complete
      ? 'bg-status-success-background text-status-success'
      : attention
        ? 'bg-status-warning-background text-status-warning-text'
        : 'bg-muted text-muted-foreground'

  return (
    <article className="grid grid-cols-[3rem_1rem_minmax(0,1fr)] gap-x-1.5">
      {receivedAt ? (
        <time
          dateTime={receivedAt.toISOString()}
          className="col-start-1 row-start-1 pt-3 text-xs tabular-nums text-chat-foreground-faint"
        >
          {receivedAt.toLocaleTimeString(locale, {
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
          })}
        </time>
      ) : null}
      <div className="relative col-start-2 row-start-1 pt-3" aria-hidden="true">
        <span
          className={cn('relative z-10 grid size-4 place-items-center rounded-full', statusTone)}
        >
          <StatusIcon
            className={cn(
              'size-4',
              routingInProgress && 'motion-safe:animate-pulse motion-safe:[animation-delay:200ms]'
            )}
          />
        </span>
        {lastOfDay ? null : <span className="absolute start-1/2 top-8 bottom-0 w-px bg-border" />}
      </div>
      <div
        className={cn(
          'col-start-3 row-start-1 flex min-w-0 flex-col',
          noWork ? 'gap-1 pb-4' : 'gap-2.5 pb-6'
        )}
      >
        <Collapsible
          id={`entry-request-${input.inputId}`}
          tabIndex={-1}
          className={cn(ENTRY_MESSAGE_SURFACE, 'px-3 py-2.5')}
          open={awaitingRoute && manualPlanOpen}
          onOpenChange={setManualPlanOpen}
        >
          <EntryMessageHeader
            icon={UserRound}
            type={t(`${ENTRY}.messageRequest`, 'Your request')}
            status={status}
            tone={failed ? 'error' : complete ? 'success' : attention ? 'warning' : 'neutral'}
          />
          <EntryMessageText text={input.text} as="h3" className="font-medium" />
          {noWork ? (
            <EntryMessageText
              text={
                input.decisionReason ??
                t(`${ENTRY}.noSubActions`, 'Routing decided nothing needs to be done.')
              }
              className="mt-1 text-muted-foreground"
            />
          ) : null}
          {awaitingRoute || input.canDelete ? (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {awaitingRoute ? (
                <>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={facts.busy || routing}
                    onClick={() => onRouteInput(input.inputId, automatic)}
                  >
                    {t(`${ENTRY}.retryRouting`, 'Retry routing')}
                  </Button>
                  <CollapsibleTrigger asChild disabled={facts.busy || routing}>
                    <Button variant="ghost" size="xs">
                      {t(`${ENTRY}.manualPlan`, 'Split manually')}
                    </Button>
                  </CollapsibleTrigger>
                </>
              ) : null}
              {input.canDelete ? (
                <EntryDeleteButton
                  scope="request"
                  disabled={facts.busy}
                  onDelete={() => onDelete()}
                />
              ) : null}
            </div>
          ) : null}
          {awaitingRoute ? (
            <CollapsibleContent>
              <EntryManualPlan
                original={input.text}
                busy={facts.busy || routing}
                onSave={(actions) => facts.savePlan(input.inputId, actions)}
                onClose={() => setManualPlanOpen(false)}
              />
            </CollapsibleContent>
          ) : null}
        </Collapsible>
        {hint ? (
          <div
            className="flex flex-col items-start gap-1 border-s-2 border-destructive/30 ps-3"
            role="status"
          >
            <p className="text-sm whitespace-pre-wrap text-chat-foreground [overflow-wrap:anywhere]">
              {hint}
            </p>
            {input.decisionStatus === 'received' && /未配置|未选择/.test(hint) ? (
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0"
                onClick={() => {
                  const state = useAppStore.getState()
                  state.openSettingsTarget({
                    pane: 'task-entry',
                    repoId: null,
                    sectionId: 'dispatch-decision-model'
                  })
                  state.openSettingsPage()
                }}
              >
                {t(`${ENTRY}.goConfigure`, 'Configure the decision model')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {input.subActions.length > 0 ? <EntryRouteCard input={input} /> : null}
        <EntryClarifyList items={input.clarifications ?? []} />
        <EntryTaskList
          key={input.inputId}
          input={input}
          repoId={repoId}
          busy={facts.busy}
          approvalByDispatch={approvalByDispatch}
          showChildDelete={showChildDelete}
          onDelete={onDelete}
          agents={agents}
          onAssign={(subActionId, agent) => {
            onHint(input.inputId, null)
            void facts.assign(input.inputId, subActionId, agent).catch((error: unknown) => {
              onHint(input.inputId, String(error))
            })
          }}
          reviews={facts.reviews}
          acceptReview={facts.acceptReview}
          handback={facts.handback}
          transfer={facts.transfer}
          fetchWorkers={facts.fetchWorkers}
          cardActions={cardActions}
          sendSupplement={facts.sendSupplement}
          onActionError={onActionError}
        />
      </div>
    </article>
  )
}
