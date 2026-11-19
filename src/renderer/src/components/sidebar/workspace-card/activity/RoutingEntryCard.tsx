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

export type RoutingEntryCardProps = {
  paused?: boolean
  inputs: RoutingEntryInput[]
  busy?: boolean
  error?: string | null
  onRefresh?: () => void
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

/** 简洁入口 (plan §9 A / §10): the four-state supplement cards over the runtime's own facts.
 *  Presentational only — facts come from orchestration.routingInputsShow, actions delegate to
 *  the handback/send RPCs. Internal ids stay in the expandable details. */
export default function RoutingEntryCard({
  paused,
  inputs,
  busy,
  error,
  onRefresh,
  onHandback,
  onSendSupplement
}: RoutingEntryCardProps) {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-2 px-3 py-2 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">{t(`${ENTRY}.title`, 'Dispatch entry')}</span>
        <div className="flex items-center gap-1">
          {paused ? <Badge variant="destructive">{t(`${ENTRY}.paused`, 'Paused')}</Badge> : null}
          <Button variant="ghost" size="sm" disabled={busy} onClick={onRefresh}>
            {t(`${ENTRY}.refresh`, 'Refresh')}
          </Button>
        </div>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {inputs.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {t(`${ENTRY}.noInputs`, 'No recorded inputs.')}
        </p>
      ) : null}
      {inputs.map((input) => (
        <div key={input.inputId} className="flex flex-col gap-1 rounded-md border p-2">
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {input.text.length > 60 ? `${input.text.slice(0, 60)}…` : input.text}
            </summary>
            <p className="mt-1 text-xs whitespace-pre-wrap">{input.text}</p>
            <p className="mt-1 text-xs text-muted-foreground" title={input.inputId}>
              {t(`${ENTRY}.input`, 'Input')} {input.inputId} ·{' '}
              {input.decisionStatus === 'decided'
                ? t(`${ENTRY}.decided`, 'Decided')
                : t(`${ENTRY}.awaitingRouting`, 'Awaiting routing')}
            </p>
          </details>
          {input.subActions.map((subAction) => {
            const badge = STATE_BADGES[subAction.state]
            return (
              <div key={subAction.subActionId} className="flex flex-col gap-1 border-t pt-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{subAction.text}</span>
                  <Badge variant={badge.variant}>{stateLabel(t, subAction.state)}</Badge>
                </div>
                {subAction.state === 'violated' && subAction.firstActionSummary ? (
                  <p className="text-xs text-destructive">{subAction.firstActionSummary}</p>
                ) : null}
                {subAction.lastOutcome === 'refused' && subAction.refusalKind ? (
                  <p className="text-xs text-muted-foreground">
                    {t(`${ENTRY}.refused`, 'Refused')}: {subAction.refusalKind}
                  </p>
                ) : null}
                {subAction.claimedBy ? (
                  <p className="text-xs text-muted-foreground" title={subAction.claimedBy}>
                    {t(`${ENTRY}.executionTarget`, 'Execution target')} {subAction.claimedBy}
                  </p>
                ) : null}
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !onSendSupplement}
                    onClick={() => onSendSupplement?.(subAction.subActionId, subAction.text)}
                  >
                    {t(`${ENTRY}.supplement`, 'Supplement')}
                  </Button>
                  {subAction.claimedBy ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || !onHandback}
                      onClick={() => onHandback?.(subAction.subActionId, subAction.claimedBy ?? '')}
                    >
                      {t(`${ENTRY}.handback`, 'Hand back')}
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
