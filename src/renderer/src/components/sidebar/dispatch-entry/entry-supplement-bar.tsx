import { Check, CircleHelp, MessageSquare, TriangleAlert } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type {
  RoutingEntryDelivery,
  RoutingEntrySubAction
} from '../workspace-card/activity/routing-entry-model'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

/** The 原型 .supplement bar: 已收到 → 已投递 → 本轮已处理 with the attempt evidence box. */
export function SupplementBar({
  delivery,
  subActionState
}: {
  delivery: RoutingEntryDelivery
  subActionState: RoutingEntrySubAction['state']
}): React.JSX.Element | null {
  const t = useTranslate()
  const delivered = delivery.attempts.find((attempt) => attempt.outcome === 'delivered')
  const lastAttempt = delivery.attempts.at(-1)
  const refused = !delivered && lastAttempt?.outcome === 'refused'
  const steps = [
    {
      key: 'received',
      label: t(`${ENTRY}.registered`, 'Received'),
      lit: true,
      fail: false,
      verify: false
    },
    {
      key: 'delivered',
      label: t(`${ENTRY}.delivered`, 'Delivered'),
      lit: Boolean(delivered),
      fail: false,
      verify: false
    },
    {
      key: 'processed',
      label: t(`${ENTRY}.processed`, 'Processed this turn'),
      lit: subActionState === 'processed',
      fail: subActionState === 'violated',
      verify: subActionState === 'pending_verification'
    }
  ]
  const stateText = delivered
    ? `→ ${delivered.turnId ?? delivery.targetDispatchId}`
    : refused
      ? lastAttempt?.refusalKind === 'paused'
        ? t(`${ENTRY}.paused`, 'Paused')
        : t(`${ENTRY}.refused`, 'Refused')
      : subActionState === 'pending_verification'
        ? t(`${ENTRY}.pending_verification`, 'Pending verification')
        : ''
  const evidenceLines = delivery.attempts.flatMap((attempt, index) => {
    const label =
      attempt.outcome === 'delivered'
        ? `${t(`${ENTRY}.delivered`, 'Delivered')}${attempt.turnId ? ` · ${attempt.turnId}` : ''}`
        : attempt.outcome === 'refused'
          ? `${t(`${ENTRY}.refused`, 'Refused')}${attempt.refusalKind ? ` · ${attempt.refusalKind}` : ''}`
          : t(`${ENTRY}.pending_verification`, 'Pending verification')
    const lines = [
      {
        key: attempt.attemptId ?? `${index}-${attempt.createdAt}`,
        ok: attempt.outcome !== 'refused',
        text: `#${index + 1} ${label}`
      }
    ]
    return attempt.firstActionSummary
      ? [
          ...lines,
          {
            key: `${attempt.attemptId ?? index}-fa`,
            ok: true,
            text: attempt.firstActionSummary
          }
        ]
      : lines
  })
  return (
    <div className="mx-3 mb-2 border-s border-border ps-2.5 py-1">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <MessageSquare aria-hidden="true" className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{delivery.text}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-0 gap-y-1.5">
        {steps
          .filter((step) => step.lit || step.fail || step.verify)
          .map((step, index) => (
            <span key={step.key} className="inline-flex items-center">
              {index > 0 ? <span aria-hidden="true" className="mx-1.5 h-px w-3 bg-border" /> : null}
              <span
                className={`inline-flex items-center gap-1 text-2xs ${
                  step.fail || step.verify ? 'text-status-warning-text' : 'text-muted-foreground'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`grid size-3.5 shrink-0 place-items-center rounded-full ${
                    step.fail || step.verify
                      ? 'bg-status-warning-background text-status-warning-text'
                      : 'bg-status-success-background text-status-success'
                  }`}
                >
                  {step.fail ? (
                    <TriangleAlert className="size-2.5" />
                  ) : step.verify ? (
                    <CircleHelp className="size-2.5" />
                  ) : (
                    <Check className="size-2.5" />
                  )}
                </span>
                {step.fail
                  ? t(`${ENTRY}.violated`, 'Turn ignored the supplement')
                  : step.verify
                    ? t(`${ENTRY}.pending_verification`, 'Pending verification')
                    : step.label}
              </span>
            </span>
          ))}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-3xs text-muted-foreground [overflow-wrap:anywhere]">
        <span>{delivery.supplementId}</span>
        {stateText ? <span>{stateText}</span> : null}
      </div>
      {evidenceLines.length > 0 ? (
        <div className="mt-1 flex flex-col gap-0.5">
          {evidenceLines.map((line) => (
            <div
              key={line.key}
              className={`flex items-center gap-1.5 font-mono text-3xs ${line.ok ? 'text-muted-foreground' : 'text-status-warning-text'}`}
            >
              {line.ok ? (
                <Check className="size-2.5 shrink-0 text-status-success" />
              ) : (
                <TriangleAlert className="size-2.5 shrink-0 text-status-warning" />
              )}
              <span className="min-w-0 truncate">{line.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
