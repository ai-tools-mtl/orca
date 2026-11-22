import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type {
  RoutingEntryApproval,
  RoutingEntryInput,
  RoutingEntrySubAction,
  RoutingReviewState
} from '../workspace-card/activity/routing-entry-model'
import type { useRoutingEntryFacts } from '../workspace-card/activity/use-routing-entry-facts'
import { EntryAssignCard, entryAssignmentPresentation } from './entry-assign-card'
import { ENTRY_MESSAGE_SURFACE, EntryMessageHeader } from './entry-message'
import { EntryStageWaitCard, entryStageWaitOf } from './entry-stage-flow'
import { EntryTaskCard, type EntryTaskActionHandlers } from './entry-task-card'
import { isEntryStageWaitingForDispatch } from './entry-task-view'
import { entryTaskPresentation } from './entry-timeline-status'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

type TaskCard = {
  action: RoutingEntrySubAction
  presentation: React.ComponentProps<typeof EntryMessageHeader>
  unread?: boolean
  detail: React.JSX.Element
}

export function EntryTaskList({
  input,
  repoId,
  busy,
  approvalByDispatch,
  showChildDelete,
  onDelete,
  agents,
  onAssign,
  reviews,
  acceptReview,
  handback,
  transfer,
  fetchWorkers,
  cardActions,
  sendSupplement,
  onActionError
}: {
  input: RoutingEntryInput
  repoId: string
  busy?: boolean
  approvalByDispatch: ReadonlyMap<string, RoutingEntryApproval>
  showChildDelete: boolean
  onDelete: (subActionId?: string) => void
  agents?: TuiAgent[]
  onAssign: (subActionId: string, agent: TuiAgent) => void
  reviews: ReadonlyMap<string, RoutingReviewState>
  acceptReview: ReturnType<typeof useRoutingEntryFacts>['acceptReview']
  handback: ReturnType<typeof useRoutingEntryFacts>['handback']
  transfer: ReturnType<typeof useRoutingEntryFacts>['transfer']
  fetchWorkers: ReturnType<typeof useRoutingEntryFacts>['fetchWorkers']
  cardActions: (action: RoutingEntrySubAction) => EntryTaskActionHandlers
  sendSupplement: ReturnType<typeof useRoutingEntryFacts>['sendSupplement']
  onActionError: (message: string | null) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const detailsId = useId()
  const [expanded, setExpanded] = useState<string>()
  const tasks = input.subActions.flatMap<TaskCard>((action) => {
    if (action.resumed) {
      return []
    }
    const remove =
      showChildDelete && action.canDelete ? () => onDelete(action.subActionId) : undefined
    if (isEntryStageWaitingForDispatch(action)) {
      const wait = entryStageWaitOf(action, input.subActions, t)
      return [
        {
          action,
          presentation: wait,
          detail: <EntryStageWaitCard action={action} wait={wait} embedded />
        }
      ]
    }
    if (!action.taskId && !action.execution && !action.queuedAt) {
      if (action.stageKind) {
        return []
      }
      return [
        {
          action,
          presentation: entryAssignmentPresentation(action, t),
          detail: (
            <EntryAssignCard
              action={action}
              reason={input.decisionReason}
              agents={agents}
              busy={busy}
              onAssign={onAssign}
              onDelete={remove}
              embedded
            />
          )
        }
      ]
    }
    const approval = action.execution
      ? approvalByDispatch.get(action.execution.dispatchId)
      : undefined
    const actions = cardActions(action)
    return [
      {
        action,
        presentation: entryTaskPresentation(action, Boolean(approval), t),
        unread: actions.unread,
        detail: (
          <EntryTaskCard
            action={action}
            inputText={input.text}
            repoId={repoId}
            embedded
            busy={busy}
            approval={approval}
            onDelete={remove}
            review={action.taskId ? reviews.get(action.taskId) : undefined}
            onAcceptReview={(taskId, cycleId, revision) => {
              onActionError(null)
              void acceptReview(taskId, cycleId, revision).catch((error: unknown) => {
                onActionError(error instanceof Error ? error.message : String(error))
              })
            }}
            onHandback={(subActionId, dispatchId) => handback(subActionId, dispatchId)}
            onReassign={(fromDispatch, targetDispatchId) =>
              transfer(
                input.inputId,
                action.subActionId,
                fromDispatch,
                targetDispatchId,
                action.lastSupplementText ?? action.text
              )
            }
            onFetchWorkers={() => fetchWorkers()}
            {...actions}
            onSendSupplement={(subActionId, text) => {
              const dispatch =
                action.claimedBy ?? action.lastTargetDispatchId ?? action.execution?.dispatchId
              if (!dispatch) {
                return undefined
              }
              onActionError(null)
              return sendSupplement(input.inputId, subActionId, dispatch, text).catch(
                (error: unknown) => {
                  onActionError(String(error))
                  throw error
                }
              )
            }}
          />
        )
      }
    ]
  })
  if (!tasks.length) {
    return null
  }
  return (
    <div className="min-w-0 space-y-1">
      <ScrollArea
        type="auto"
        scrollbarOrientation="horizontal"
        className="@container has-[[data-slot=scroll-area-scrollbar]]:pb-3"
      >
        <div className="flex gap-2 p-1">
          {tasks.map(({ action, presentation, unread }) => {
            const id = action.subActionId
            const open = expanded === id
            const stageText = action.stageKind
              ? /^([^:\n：]{1,48})[:：][ \t]*([\s\S]+)$/.exec(action.text)
              : null
            return (
              <Button
                key={id}
                id={`entry-task-${id}`}
                data-entry-task-id={action.taskId}
                data-entry-task-trigger=""
                type="button"
                variant="ghost"
                aria-expanded={open}
                aria-controls={`${detailsId}-${id}`}
                onClick={() => setExpanded(open ? undefined : id)}
                className={cn(
                  ENTRY_MESSAGE_SURFACE,
                  'group h-auto min-h-26 w-[min(12rem,calc(100cqw-0.5rem))] max-w-72 grow shrink-0 flex-col items-stretch justify-start gap-1 px-3 py-2.5 text-start font-normal whitespace-normal',
                  'aria-expanded:border-ring aria-expanded:bg-accent'
                )}
              >
                <EntryMessageHeader {...presentation} />
                <span className="line-clamp-3 font-medium [overflow-wrap:anywhere]">
                  {unread ? (
                    <span
                      className="me-1.5 inline-block size-1.5 rounded-full bg-chat-unread align-middle"
                      role="img"
                      aria-label={t(`${ENTRY}.unreadLabel`, 'New result')}
                    />
                  ) : null}
                  {stageText?.[1] ?? action.text}
                </span>
                {stageText ? (
                  <span className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {stageText[2]}
                  </span>
                ) : null}
                <ChevronDown
                  aria-hidden="true"
                  className="mt-auto size-3.5 self-end text-muted-foreground group-aria-expanded:rotate-180"
                />
              </Button>
            )
          })}
        </div>
      </ScrollArea>
      {tasks.map(({ action, detail }) => (
        <div
          key={action.subActionId}
          id={`${detailsId}-${action.subActionId}`}
          hidden={expanded !== action.subActionId}
        >
          {detail}
        </div>
      ))}
    </div>
  )
}
