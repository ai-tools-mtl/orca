import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

export type RoutingEntrySubAction = {
  subActionId: string
  text: string
  state: 'registered' | 'delivered' | 'processed' | 'violated' | 'pending_verification'
  claimedBy?: string
  lastOutcome?: 'delivered' | 'refused' | 'unverified'
  refusalKind?: string
  firstActionSummary?: string
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

/** One request card of the 统一任务入口 stream (plan §24): the original message on top, its
 *  sub-actions below with the four-state facts, and the card-level supplement form delivering
 *  to the claimed Dispatch's active turn. Presentational — facts come from entryShow. */
export default function RoutingRequestCard({
  input,
  busy,
  error,
  onHandback,
  onSendSupplement
}: RoutingRequestCardProps) {
  const t = useTranslate()
  const claimed = input.subActions.find((subAction) => subAction.claimedBy)
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border p-2.5">
      <p className="text-sm whitespace-pre-wrap">{input.text}</p>
      <p className="text-muted-foreground text-xs" title={input.inputId}>
        {t(`${ENTRY}.input`, 'Input')} {input.inputId} ·{' '}
        {input.decisionStatus === 'decided'
          ? t(`${ENTRY}.decided`, 'Decided')
          : t(`${ENTRY}.awaitingRouting`, 'Awaiting routing')}
      </p>
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
      {input.subActions.map((subAction) => {
        const badge = STATE_BADGES[subAction.state]
        return (
          <div key={subAction.subActionId} className="flex flex-col gap-1 border-t pt-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm">{subAction.text}</span>
              <Badge variant={badge.variant}>{stateLabel(t, subAction.state)}</Badge>
            </div>
            {subAction.state === 'violated' && subAction.firstActionSummary ? (
              <p className="text-destructive text-xs">{subAction.firstActionSummary}</p>
            ) : null}
            {subAction.lastOutcome === 'refused' && subAction.refusalKind ? (
              <p className="text-muted-foreground text-xs">
                {t(`${ENTRY}.refused`, 'Refused')}: {subAction.refusalKind}
              </p>
            ) : null}
            {subAction.claimedBy ? (
              <p className="text-muted-foreground text-xs" title={subAction.claimedBy}>
                {t(`${ENTRY}.executionTarget`, 'Execution target')} {subAction.claimedBy}
              </p>
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
