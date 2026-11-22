import { useId, useState } from 'react'
import { ChevronDown, ListTodo, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { EntryTimelineStatusBadge } from './entry-timeline-status-badge'
import type { EntryTimelineStatus } from './entry-timeline-status'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

export const ENTRY_MESSAGE_SURFACE =
  'min-w-0 rounded-xl border border-border bg-card text-card-foreground'

export function EntryMessageHeader({
  icon: Icon = ListTodo,
  type,
  sender,
  status,
  activity,
  tone = 'neutral'
}: {
  icon?: LucideIcon
  type?: string
  sender?: string
  status: string
  activity?: EntryTimelineStatus
  tone?: 'neutral' | 'success' | 'warning' | 'error'
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <span className="mb-1 flex flex-wrap items-start justify-between gap-x-3 gap-y-1 text-xs">
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="font-medium">{type ?? t(`${ENTRY}.boardTaskKind`, 'Task')}</span>
        {sender ? <span className="[overflow-wrap:anywhere]">· {sender}</span> : null}
      </span>
      {activity ? (
        <span className="ms-auto">
          <EntryTimelineStatusBadge status={activity} label={status} />
        </span>
      ) : (
        <span
          className={cn(
            'ms-auto max-w-full text-end font-medium [overflow-wrap:anywhere]',
            {
              neutral: 'text-muted-foreground',
              success: 'text-status-success',
              warning: 'text-status-warning-text',
              error: 'text-destructive'
            }[tone]
          )}
        >
          {status}
        </span>
      )}
    </span>
  )
}

export function EntryMessageText({
  text,
  as: Text = 'p',
  className,
  unreadLabel,
  onExpand,
  showFullText = false
}: {
  text: string
  as?: 'p' | 'h3' | 'h4'
  className?: string
  unreadLabel?: string
  onExpand?: () => void
  showFullText?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const [open, setOpen] = useState(showFullText)
  const preview = showFullText
    ? text
    : Array.from(text.split('\n', 3).join('\n')).slice(0, 100).join('')
  const long = preview.length < text.length
  const body = (
    <Text
      id={id}
      className={cn(
        'min-w-0 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]',
        long && !open && 'line-clamp-3',
        className
      )}
    >
      {unreadLabel ? (
        <span
          className="me-1.5 inline-block size-1.5 rounded-full bg-chat-unread align-middle"
          role="img"
          aria-label={unreadLabel}
        />
      ) : null}
      {long && !open ? `${preview.trimEnd()}…` : text}
    </Text>
  )
  if (!long) {
    return body
  }
  return (
    <div>
      {body}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open)
          if (!open) {
            onExpand?.()
          }
        }}
        className="group mt-0.5 gap-1 text-muted-foreground"
      >
        {open
          ? t(`${ENTRY}.messageCollapse`, 'Show less')
          : t(`${ENTRY}.messageExpand`, 'Show more')}
        <ChevronDown className="size-3 group-aria-expanded:rotate-180" aria-hidden="true" />
      </Button>
    </div>
  )
}
