import { CirclePlay, Clock3, MessageCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { EntryTimelineStatus } from './entry-timeline-status'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

export function EntryTimelineStatusBadge({
  status,
  count,
  label
}: {
  status: EntryTimelineStatus
  count?: number
  label?: string
}): React.JSX.Element {
  const t = useTranslate()
  const statusLabels = {
    running: t(`${ENTRY}.workerRunning`, 'Running'),
    queued: t(`${ENTRY}.boardQueued`, 'Queued'),
    reply: t(`${ENTRY}.timelineAwaitingReply`, 'Awaiting reply')
  }
  const Icon = { running: CirclePlay, queued: Clock3, reply: MessageCircle }[status]
  return (
    <Badge
      variant="secondary"
      className={cn(
        'max-w-full gap-1 px-1.5 font-medium whitespace-normal',
        status === 'running' && 'text-status-warning-text',
        status === 'queued' && 'text-muted-foreground',
        status === 'reply' && 'bg-status-warning-background text-status-warning-text'
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {label ?? statusLabels[status]}
      {count === undefined ? null : <span className="tabular-nums">{count}</span>}
    </Badge>
  )
}
