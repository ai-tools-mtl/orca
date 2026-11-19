import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type {
  RoutingEntryExecution,
  RoutingEntryWorker,
  RoutingReviewState
} from './routing-entry-model'

export type RoutingEntrySubAction = {
  subActionId: string
  text: string
  state: 'registered' | 'delivered' | 'processed' | 'violated' | 'pending_verification'
  taskId?: string
  execution?: RoutingEntryExecution
  claimedBy?: string
  refusalKind?: string
  firstActionSummary?: string
  /** Delivery attempts oldest first (§6 ledger rows) — the card's 阶段时间线. */
  history: {
    outcome: 'delivered' | 'refused' | 'unverified'
    createdAt: string
    refusalKind?: string
    turnId?: string
    expectedTurnId?: string
    firstActionSummary?: string
    targetDispatchId: string
    supplementText: string
  }[]
  lastSupplementText?: string
  lastTargetDispatchId?: string
}

export type RoutingEntryInput = {
  inputId: string
  text: string
  decisionStatus: 'received' | 'decided'
  subActions: RoutingEntrySubAction[]
}

export type RoutingRequestCardProps = {
  input: RoutingEntryInput
  busy?: boolean
  error?: string | null
  reviews?: ReadonlyMap<string, RoutingReviewState>
  onAcceptReview?: (taskId: string) => void
  onHandback?: (subActionId: string, dispatchId: string) => void
  onReassign?: (subActionId: string, targetDispatchId: string) => void
  onFetchWorkers?: () => Promise<RoutingEntryWorker[]>
  onSendSupplement?: (subActionId: string, text: string) => void
  onAssign?: (subActionId: string, agent: TuiAgent) => void
  agents?: TuiAgent[]
}

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

const EXECUTION_LABELS = {
  pending: ['workerStarting', 'Starting worker'],
  dispatched: ['workerRunning', 'Running'],
  attention: ['workerAttention', 'Needs attention'],
  completed: ['workerCompleted', 'Completed'],
  failed: ['workerFailed', 'Failed'],
  circuit_broken: ['workerFailed', 'Failed']
} as const

const STATE_BADGES: Record<
  RoutingEntrySubAction['state'],
  { variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  registered: { variant: 'secondary' },
  delivered: { variant: 'outline' },
  processed: { variant: 'default' },
  violated: { variant: 'destructive' },
  pending_verification: { variant: 'secondary' }
}

function stateLabel(
  t: (key: string, fallback: string) => string,
  state: RoutingEntrySubAction['state']
): string {
  switch (state) {
    case 'registered':
      return t('auto.components.sidebar.RoutingEntryCard.registered', 'Received')
    case 'delivered':
      return t('auto.components.sidebar.RoutingEntryCard.delivered', 'Delivered')
    case 'processed':
      return t('auto.components.sidebar.RoutingEntryCard.processed', 'Processed this turn')
    case 'violated':
      return t('auto.components.sidebar.RoutingEntryCard.violated', 'Turn ignored the supplement')
    case 'pending_verification':
      return t(
        'auto.components.sidebar.RoutingEntryCard.pending_verification',
        'Pending verification'
      )
  }
}

function outcomeLabel(
  t: (key: string, fallback: string) => string,
  outcome: RoutingEntrySubAction['history'][number]['outcome']
): string {
  switch (outcome) {
    case 'delivered':
      return t('auto.components.sidebar.RoutingEntryCard.delivered', 'Delivered')
    case 'refused':
      return t('auto.components.sidebar.RoutingEntryCard.refused', 'Refused')
    case 'unverified':
      return t(
        'auto.components.sidebar.RoutingEntryCard.pending_verification',
        'Pending verification'
      )
  }
}

function reviewLabel(
  t: (key: string, fallback: string) => string,
  state: 'reviewing' | 'rework' | 'accepted'
): string {
  switch (state) {
    case 'reviewing':
      return t(`${ENTRY}.reviewReviewing`, 'In review')
    case 'rework':
      return t(`${ENTRY}.reviewRework`, 'Rework')
    case 'accepted':
      return t(`${ENTRY}.reviewAccepted`, 'Accepted')
  }
}

function localTime(utcSqlite: string): string {
  const date = new Date(`${utcSqlite}Z`)
  return Number.isNaN(date.getTime())
    ? utcSqlite
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** The answer side of one request (plan §24): the sub-action facts under the bubble, with the
 *  delivery timeline (§6 ledger rows), review cycle state (§7), handback and the
 *  「补充要求 · 投递到当前轮次」 form delivering to the claimed Dispatch's active turn. */
export default function RoutingRequestCard({
  input,
  busy,
  error,
  reviews,
  onAcceptReview,
  onHandback,
  onReassign,
  onFetchWorkers,
  onSendSupplement,
  onAssign,
  agents
}: RoutingRequestCardProps) {
  const t = useTranslate()
  const [reassignFor, setReassignFor] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<RoutingEntryWorker[] | null>(null)
  const claimed = input.subActions.find((subAction) => subAction.claimedBy)
  return (
    <div className="flex flex-col gap-2">
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
      {input.subActions.map((subAction) => {
        const badge = STATE_BADGES[subAction.state]
        const review = subAction.taskId ? reviews?.get(subAction.taskId) : undefined
        const lastAttempt = subAction.history.at(-1)
        const retryDispatch = subAction.claimedBy ?? subAction.lastTargetDispatchId
        const retryText = subAction.lastSupplementText ?? input.text
        const execution = subAction.execution
        const executionLabel = execution && EXECUTION_LABELS[execution.status]
        return (
          <article
            key={subAction.subActionId}
            aria-label={subAction.text}
            className="flex flex-col gap-1 rounded-lg border bg-card p-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 whitespace-pre-wrap break-words text-sm">
                {subAction.text}
              </span>
              {executionLabel ? (
                <Badge
                  variant={
                    execution.status === 'failed' || execution.status === 'circuit_broken'
                      ? 'destructive'
                      : 'secondary'
                  }
                >
                  {t(`${ENTRY}.${executionLabel[0]}`, executionLabel[1])}
                </Badge>
              ) : (
                <Badge variant={badge.variant}>{stateLabel(t, subAction.state)}</Badge>
              )}
            </div>
            {execution?.agent ? (
              <p className="text-muted-foreground text-xs">
                {isTuiAgent(execution.agent)
                  ? TUI_AGENT_DISPLAY_NAMES[execution.agent]
                  : execution.agent}
              </p>
            ) : null}
            {execution?.result ? (
              <p className="whitespace-pre-wrap break-words text-sm">{execution.result}</p>
            ) : null}
            {execution?.failure ? (
              <p className="whitespace-pre-wrap break-words text-destructive text-xs">
                {execution.failure}
              </p>
            ) : null}
            {!subAction.taskId && onAssign && agents ? (
              <div className="self-start">
                {agents.length > 0 ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" disabled={busy}>
                        {t(`${ENTRY}.assignWorker`, 'Assign worker')}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {agents.map((agent) => (
                        <DropdownMenuItem
                          key={agent}
                          onSelect={() => onAssign(subAction.subActionId, agent)}
                        >
                          {TUI_AGENT_DISPLAY_NAMES[agent]}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    {t(`${ENTRY}.noAgents`, 'No workers detected on this project host.')}
                  </p>
                )}
              </div>
            ) : null}
            {subAction.state === 'violated' && subAction.firstActionSummary ? (
              <p className="text-destructive text-xs">{subAction.firstActionSummary}</p>
            ) : null}
            {lastAttempt?.outcome === 'refused' && lastAttempt.refusalKind ? (
              <p className="text-muted-foreground text-xs">
                {t(`${ENTRY}.refused`, 'Refused')}: {lastAttempt.refusalKind}
              </p>
            ) : null}
            {subAction.claimedBy ? (
              <p className="text-muted-foreground text-xs" title={subAction.claimedBy}>
                {t(`${ENTRY}.executionTarget`, 'Execution target')} {subAction.claimedBy}
              </p>
            ) : null}
            {subAction.history.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                {subAction.history.map((attempt) => (
                  <div
                    key={`${attempt.createdAt}:${attempt.outcome}:${attempt.turnId ?? ''}`}
                    className="flex items-center gap-1.5 text-[11px]"
                  >
                    <span
                      className={
                        attempt.outcome === 'delivered'
                          ? 'text-status-success'
                          : attempt.outcome === 'refused'
                            ? 'text-destructive'
                            : 'text-muted-foreground'
                      }
                    >
                      {outcomeLabel(t, attempt.outcome)}
                    </span>
                    {attempt.refusalKind ? (
                      <span className="text-muted-foreground">{attempt.refusalKind}</span>
                    ) : null}
                    {attempt.turnId ? (
                      <span className="font-mono text-muted-foreground/70 opacity-70">
                        {attempt.turnId}
                      </span>
                    ) : null}
                    <span className="flex-1" />
                    <span className="text-muted-foreground opacity-70">
                      {localTime(attempt.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {review?.cycle ? (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>
                  {t(`${ENTRY}.reviewLabel`, 'Review')} R{review.cycle.current_revision} ·{' '}
                  {reviewLabel(t, review.cycle.state)}
                </span>
                {review.opinions.some((opinion) => opinion.state === 'blocked') ? (
                  <span className="text-destructive">
                    {review.opinions.filter((opinion) => opinion.state === 'blocked').length}{' '}
                    {t(`${ENTRY}.reviewBlocking`, 'blocking')}
                  </span>
                ) : null}
                <span className="flex-1" />
                {review.cycle.state !== 'accepted' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || !onAcceptReview}
                    onClick={() => onAcceptReview?.(subAction.taskId ?? '')}
                  >
                    {t(`${ENTRY}.accept`, 'Accept')}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {lastAttempt && lastAttempt.outcome !== 'delivered' && retryDispatch ? (
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                disabled={busy || !onSendSupplement}
                onClick={() => onSendSupplement?.(subAction.subActionId, retryText)}
              >
                {t(`${ENTRY}.retry`, 'Retry')}
              </Button>
            ) : null}
          </article>
        )
      })}
      {claimed ? (
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !onHandback}
            onClick={() => onHandback?.(claimed.subActionId, claimed.claimedBy ?? '')}
          >
            {t(`${ENTRY}.handback`, 'Hand back')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !onFetchWorkers}
            onClick={() => {
              if (!onFetchWorkers) {
                return
              }
              if (reassignFor === claimed.subActionId && candidates) {
                setReassignFor(null)
                setCandidates(null)
                return
              }
              setReassignFor(claimed.subActionId)
              setCandidates([])
              void onFetchWorkers().then((workers) => {
                setCandidates(workers.filter((worker) => worker.dispatchId !== claimed.claimedBy))
              })
            }}
          >
            {t(`${ENTRY}.reassign`, 'Reassign')}
          </Button>
          {reassignFor === claimed.subActionId && candidates !== null ? (
            <div className="flex flex-col gap-0.5 rounded-md border border-dashed p-1.5">
              {candidates.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  {t(`${ENTRY}.noOtherWorkers`, 'No other worker to reassign to.')}
                </p>
              ) : null}
              {candidates.map((worker) => (
                <Button
                  key={worker.dispatchId}
                  variant="ghost"
                  size="sm"
                  disabled={busy || !onReassign}
                  className="justify-start"
                  onClick={() => {
                    onReassign?.(claimed.subActionId, worker.dispatchId)
                    setReassignFor(null)
                    setCandidates(null)
                  }}
                >
                  {worker.handle}
                  <span className="text-muted-foreground"> · {worker.dispatchStatus}</span>
                </Button>
              ))}
            </div>
          ) : null}
          <form
            className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2"
            onSubmit={(event) => {
              event.preventDefault()
              const form = event.currentTarget
              const raw = new FormData(form).get('supplement')
              const text = typeof raw === 'string' ? raw.trim() : ''
              if (!text) {
                return
              }
              onSendSupplement?.(claimed.subActionId, text)
              form.reset()
            }}
          >
            <input
              name="supplement"
              disabled={busy}
              placeholder={t(
                `${ENTRY}.supplementPlaceholder`,
                'Supplement · deliver to the active turn'
              )}
              className="min-w-0 flex-1 border-none bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </form>
        </div>
      ) : null}
    </div>
  )
}
