import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { RoutingReviewState } from './routing-entry-model'

export type RoutingEntrySubAction = {
  subActionId: string
  text: string
  state: 'registered' | 'delivered' | 'processed' | 'violated' | 'pending_verification'
  taskId?: string
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
  onSendSupplement?: (subActionId: string, text: string) => void
}

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

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
  onSendSupplement
}: RoutingRequestCardProps) {
  const t = useTranslate()
  const claimed = input.subActions.find((subAction) => subAction.claimedBy)
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-card p-2.5">
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
      {input.subActions.map((subAction) => {
        const badge = STATE_BADGES[subAction.state]
        const review = subAction.taskId ? reviews?.get(subAction.taskId) : undefined
        const lastAttempt = subAction.history.at(-1)
        const retryDispatch = subAction.claimedBy ?? subAction.lastTargetDispatchId
        const retryText = subAction.lastSupplementText ?? input.text
        return (
          <div
            key={subAction.subActionId}
            className="flex flex-col gap-1 border-b pb-1.5 last:border-b-0 last:pb-0"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm">{subAction.text}</span>
              <Badge variant={badge.variant}>{stateLabel(t, subAction.state)}</Badge>
            </div>
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
          </div>
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
