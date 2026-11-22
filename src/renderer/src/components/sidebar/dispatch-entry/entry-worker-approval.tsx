import { ShieldCheck, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SecuritySurface } from '@/components/ui/security-surface'
import { EntryMessageHeader, EntryMessageText } from './entry-message'
import { useTranslate } from '@/i18n/use-translate'
import type { RoutingEntryApproval } from '../workspace-card/activity/routing-entry-model'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

/** The 原型 .q-card form: an approval prompt inline in the task card body. */
export function EntryWorkerApproval({
  approval,
  context,
  busy,
  paused,
  onAnswer
}: {
  approval: RoutingEntryApproval
  context?: React.ReactNode
  busy: boolean
  paused: boolean
  onAnswer: (decision: 'allow' | 'deny') => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SecuritySurface>
      <div className="border-t border-[color-mix(in_srgb,var(--agent-question)_28%,var(--border))] bg-[color-mix(in_srgb,var(--agent-question)_4%,var(--card))] px-3 py-2.5">
        <EntryMessageHeader
          icon={ShieldCheck}
          type={t(`${ENTRY}.messageApproval`, 'Approval request')}
          status={
            approval.interrupted
              ? t(`${ENTRY}.messageInterrupted`, 'Interrupted')
              : t(`${ENTRY}.messageAwaitingConfirmation`, 'Awaiting confirmation')
          }
          tone="warning"
        />
        {context}
        <EntryMessageText text={approval.title} className="font-medium" />
        {approval.detail ? (
          <EntryMessageText text={approval.detail} className="mt-1 text-muted-foreground" />
        ) : null}
        <p className="mt-1 font-mono text-2xs text-muted-foreground [overflow-wrap:anywhere]">
          {approval.workerHandle}
        </p>
        {approval.interrupted ? (
          <p className="mt-1 text-2xs text-muted-foreground">
            {t(
              `${ENTRY}.interruptedApproval`,
              'The approval was interrupted. Request it again before allowing the operation.'
            )}
          </p>
        ) : null}
        {approval.reason ? (
          <div className="mt-1.5 flex items-center gap-1.5 font-mono text-3xs text-chat-foreground-faint">
            <TriangleAlert className="size-2.5 shrink-0" />
            <span className="min-w-0 truncate">{approval.reason}</span>
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || paused} onClick={() => onAnswer('allow')}>
            {approval.interrupted
              ? t(`${ENTRY}.renewApproval`, 'Request approval again')
              : t(`${ENTRY}.allow`, 'Allow')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || (paused && approval.interrupted)}
            onClick={() => onAnswer('deny')}
          >
            {t(`${ENTRY}.deny`, 'Deny')}
          </Button>
        </div>
      </div>
    </SecuritySurface>
  )
}
