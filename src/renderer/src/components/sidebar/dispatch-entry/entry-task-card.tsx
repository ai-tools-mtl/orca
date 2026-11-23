import React from 'react'
import { Check, Eye, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type {
  RoutingEntryApproval,
  RoutingEntrySubAction,
  RoutingEntryWorker,
  RoutingReviewState
} from '../workspace-card/activity/routing-entry-model'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { EntryDeleteButton } from './entry-delete-button'
import { EntryAgentPickList } from './entry-assign-card'
import { EntryTaskBadges } from './entry-task-badges'
import { EntryCardActions } from './entry-card-actions'
import { SupplementBar } from './entry-supplement-bar'
import { useWorktreeName } from './entry-task-view'
import { ENTRY_MESSAGE_SURFACE, EntryMessageHeader, EntryMessageText } from './entry-message'
import { entryTaskPresentation } from './entry-timeline-status'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

function EventRow({
  icon,
  tone,
  title,
  text
}: {
  icon: React.JSX.Element
  tone?: 'warn' | 'error'
  title: string
  text?: string
}): React.JSX.Element {
  const toneClass =
    tone === 'error'
      ? 'text-destructive'
      : tone === 'warn'
        ? 'text-status-warning-text'
        : 'text-muted-foreground'
  return (
    <div
      className={cn(
        'flex gap-2.5 px-3 py-2 text-sm',
        tone === 'error' && 'bg-destructive/5',
        tone === 'warn' && 'bg-status-warning-background'
      )}
    >
      <span className={cn('mt-0.5 grid size-4 shrink-0 place-items-center', toneClass)}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <span className={cn('block font-medium', tone && toneClass)}>{title}</span>
        {text ? <EntryMessageText text={text} className="mt-0.5 text-muted-foreground" /> : null}
      </div>
    </div>
  )
}

export type EntryTaskCardProps = {
  action: RoutingEntrySubAction
  inputText: string
  repoId: string
  embedded?: boolean
  busy?: boolean
  unread?: boolean
  approval?: RoutingEntryApproval
  renderApproval?: (approval: RoutingEntryApproval) => React.JSX.Element
  review?: RoutingReviewState
  /** 失败卡的人工位（§执行失败兜底）：可选 agent 列表 + 重指派回调，出现即渲染指派区。 */
  assignAgents?: TuiAgent[]
  onAssignAgent?: (subActionId: string, agent: TuiAgent) => void
  onAcceptReview?: (taskId: string, cycleId: string, revision: number) => void
  onHandback?: (subActionId: string, dispatchId: string) => Promise<void>
  onReassign?: (fromDispatch: string | null, targetDispatchId: string) => Promise<void>
  onFetchWorkers?: () => Promise<RoutingEntryWorker[]>
  onSendSupplement?: (subActionId: string, text: string) => Promise<void> | void
  onTogglePause?: (paused: boolean) => void
  onOpenSession?: () => void
  onOpenDiff?: () => void
  onOpenResult?: () => void
  onDelete?: () => void
}

export type EntryTaskActionHandlers = Pick<
  EntryTaskCardProps,
  'unread' | 'onTogglePause' | 'onOpenSession' | 'onOpenDiff' | 'onOpenResult'
>

export function EntryTaskCard({
  action,
  inputText,
  repoId,
  embedded,
  busy,
  unread,
  approval,
  renderApproval,
  review,
  assignAgents,
  onAssignAgent,
  onAcceptReview,
  onHandback,
  onReassign,
  onFetchWorkers,
  onSendSupplement,
  onTogglePause,
  onOpenSession,
  onOpenDiff,
  onOpenResult,
  onDelete
}: EntryTaskCardProps): React.JSX.Element {
  const t = useTranslate()
  const worktreeName = useWorktreeName(repoId, action.execution?.worktreeId)
  const execution = action.execution
  const paused = Boolean(action.pausedAt)
  const queued = Boolean(action.queuedAt) && !execution
  const { state: cardState, ...presentation } = entryTaskPresentation(action, Boolean(approval), t)
  const turns =
    1 +
    new Set(
      action.deliveries.flatMap((delivery) =>
        delivery.attempts
          .filter((attempt) => attempt.outcome === 'delivered' && attempt.turnId)
          .map((attempt) => attempt.turnId)
      )
    ).size
  const supplementTarget = action.claimedBy ?? action.lastTargetDispatchId ?? execution?.dispatchId
  const lastDelivery = action.deliveries.at(-1)
  const lastAttempt = lastDelivery?.attempts.at(-1)
  const transferred = action.claimedBy && action.claimedBy !== execution?.dispatchId
  const retryable =
    (!execution || transferred) &&
    supplementTarget &&
    lastDelivery?.targetDispatchId === supplementTarget &&
    lastAttempt?.outcome === 'refused' &&
    lastAttempt.refusalKind !== 'paused' &&
    lastAttempt.refusalKind !== 'awaiting-answer'
  const showSupplementForm =
    onSendSupplement &&
    supplementTarget &&
    !paused &&
    (execution?.status === 'dispatched' || execution?.status === 'attention' || transferred)
  const blockedOpinions = review
    ? review.opinions.filter((opinion) => opinion.state === 'blocked').length
    : 0

  const taskIdentifiers = (
    <div className="flex flex-wrap items-center gap-2.5 font-mono text-2xs text-muted-foreground [overflow-wrap:anywhere]">
      <span>
        {t(`${ENTRY}.subActionLabel`, 'Sub-action')} {action.subActionId}
      </span>
      {execution ? (
        <>
          <span>Dispatch {execution.dispatchId}</span>
          <span>
            {t(`${ENTRY}.turnLabel`, 'Turn')} t{turns}
          </span>
        </>
      ) : null}
    </div>
  )

  return (
    <article
      id={embedded ? undefined : `entry-task-${action.subActionId}`}
      data-entry-task-id={embedded ? undefined : action.taskId}
      data-state={cardState}
      aria-label={action.text}
      tabIndex={-1}
      className={cn(
        ENTRY_MESSAGE_SURFACE,
        'flex flex-col overflow-hidden focus-visible:outline-2 focus-visible:outline-ring'
      )}
    >
      <div className="px-3 py-2.5">
        <EntryMessageHeader {...presentation} />
        <EntryMessageText
          as="h4"
          text={action.text}
          className="font-medium"
          unreadLabel={unread ? t(`${ENTRY}.unreadLabel`, 'New result') : undefined}
        />
        <EntryTaskBadges
          worktreeName={worktreeName}
          readOnly={execution?.readOnly}
          queued={queued}
        />
        {onOpenResult ? (
          <Button type="button" variant="ghost" size="xs" onClick={onOpenResult}>
            {t(`${ENTRY}.timelineViewResult`, 'View result')}
          </Button>
        ) : null}
        {onDelete ? (
          <EntryDeleteButton scope="sub-action" disabled={busy} onDelete={onDelete} />
        ) : null}
      </div>
      <div className="flex flex-col empty:hidden">
        {execution && execution.status !== 'pending' && execution.status !== 'completed' ? (
          <EventRow
            icon={<Check className="size-3" />}
            title={t(`${ENTRY}.dispatchedEvent`, 'Accepted and dispatched')}
          />
        ) : null}
        {review?.issue ? (
          <p className="px-3 pb-1 text-2xs text-muted-foreground">{review.issue}</p>
        ) : null}
        {review?.cycle ? (
          <div className="flex flex-col">
            <EventRow
              icon={<Eye className="size-3" />}
              title={`${t(`${ENTRY}.reviewLabel`, 'Review')} R${review.cycle.current_revision} · ${
                review.cycle.state === 'reviewing'
                  ? t(`${ENTRY}.reviewReviewing`, 'In review')
                  : review.cycle.state === 'rework'
                    ? t(`${ENTRY}.reviewRework`, 'Rework')
                    : t(`${ENTRY}.reviewAccepted`, 'Accepted')
              }`}
              text={
                blockedOpinions > 0
                  ? `${blockedOpinions} ${t(`${ENTRY}.reviewBlocking`, 'blocking')}`
                  : undefined
              }
            />
            {review.opinions.map((opinion) => (
              <p
                key={opinion.opinion_id}
                className={`px-3 pb-1 text-2xs ${opinion.state === 'blocked' ? 'text-agent-question' : 'text-muted-foreground'}`}
              >
                {opinion.opinion_id} · {opinion.body}
              </p>
            ))}
            {review.canAccept && onAcceptReview ? (
              <div className="flex gap-2 px-3 pb-2.5 pt-1">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    onAcceptReview(
                      action.taskId ?? '',
                      review.cycle!.cycle_id,
                      review.cycle!.current_revision
                    )
                  }
                >
                  {t(`${ENTRY}.accept`, 'Accept')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        {execution?.result && !onOpenResult ? (
          <div className="px-3 pb-2.5">
            <EntryMessageText text={execution.result} />
          </div>
        ) : null}
        {execution?.failure && !onOpenResult ? (
          <EventRow
            icon={<TriangleAlert className="size-3" />}
            tone="error"
            title={
              action.assignmentFailed
                ? t(`${ENTRY}.dispatchFailed`, 'Dispatch failed')
                : t(`${ENTRY}.failedEvent`, 'Execution failed')
            }
            text={execution.failure}
          />
        ) : null}
        {action.state === 'violated' && action.firstActionSummary ? (
          <EventRow
            icon={<TriangleAlert className="size-3" />}
            tone="warn"
            title={t(`${ENTRY}.violated`, 'Turn ignored the supplement')}
            text={action.firstActionSummary}
          />
        ) : null}
        {action.deliveries.map((delivery) => (
          <SupplementBar
            key={delivery.supplementId}
            delivery={delivery}
            subActionState={action.state}
          />
        ))}
        {approval && renderApproval ? renderApproval(approval) : null}
        {cardState === 'failed' && onAssignAgent ? (
          <div className="border-t px-3 pb-2.5 pt-2">
            <p className="px-0.5 pb-1 text-2xs text-muted-foreground">
              {t(`${ENTRY}.reassignTitle`, 'Reassign another worker to continue the chain')}
            </p>
            <EntryAgentPickList
              agents={assignAgents}
              busy={busy}
              onPick={(agent) => onAssignAgent(action.subActionId, agent)}
            />
          </div>
        ) : null}
      </div>
      <div className="px-3 pb-2">{taskIdentifiers}</div>
      <EntryCardActions
        action={action}
        repoId={repoId}
        inputText={inputText}
        busy={busy}
        paused={paused}
        showSupplementForm={Boolean(showSupplementForm)}
        retryable={Boolean(retryable)}
        onTogglePause={onTogglePause}
        onOpenSession={onOpenSession}
        onOpenDiff={onOpenDiff}
        onHandback={onHandback}
        onReassign={onReassign}
        onFetchWorkers={onFetchWorkers}
        onSendSupplement={onSendSupplement}
      />
    </article>
  )
}
