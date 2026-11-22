import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type {
  RoutingEntrySubAction,
  RoutingReviewState
} from '../workspace-card/activity/routing-entry-model'
import { entryResultActionOf, type EntryTimelineEvent } from './entry-timeline-events'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

type TimelineItem = { id: string; title: string; markRead?: RoutingEntrySubAction }
type SelectItem = (id: string, markRead?: RoutingEntrySubAction) => void

function TimelineJumpMenu({
  items,
  label,
  onSelect
}: {
  items: TimelineItem[]
  label: string
  onSelect: SelectItem
}): React.JSX.Element {
  if (items.length === 1) {
    const [item] = items
    return (
      <Button size="xs" variant="outline" onClick={() => onSelect(item.id, item.markRead)}>
        {label}
      </Button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="outline">
          {label}
          <ChevronDown className="size-3" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 w-72 max-w-[calc(100vw-1rem)] overflow-y-auto scrollbar-sleek"
      >
        {items.map((item) => (
          <DropdownMenuItem key={item.id} onSelect={() => onSelect(item.id, item.markRead)}>
            <span className="line-clamp-2 [overflow-wrap:anywhere]">{item.title}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function EntryTimelinePending({
  events,
  reviews,
  isUnread,
  onSelect
}: {
  events: readonly EntryTimelineEvent[]
  reviews: ReadonlyMap<string, RoutingReviewState>
  isUnread: (action: RoutingEntrySubAction) => boolean
  onSelect: SelectItem
}): React.JSX.Element | null {
  const t = useTranslate()
  const replies: TimelineItem[] = []
  const confirmations: TimelineItem[] = []
  const unread: TimelineItem[] = []
  for (const event of events) {
    const result = entryResultActionOf(event)
    if (result && isUnread(result)) {
      unread.push({ id: event.id, title: result.text, markRead: result })
    }
    switch (event.kind) {
      case 'request':
        for (const action of event.input.subActions) {
          if (!action.resumed && action.taskId && reviews.get(action.taskId)?.canAccept) {
            confirmations.push({ id: `entry-task-${action.subActionId}`, title: action.text })
          }
        }
        break
      case 'ask':
        if (!('answer' in event.ask)) {
          replies.push({ id: event.id, title: event.ask.body })
        }
        break
      case 'approval':
        confirmations.push({ id: event.id, title: event.approval.title })
        break
      case 'checkpoint':
        if (event.state === 'waiting') {
          confirmations.push({ id: event.id, title: event.action.text })
        }
        break
    }
  }

  const shortcuts = [
    {
      key: 'replies',
      items: replies,
      label: t(`${ENTRY}.timelinePendingReplies`, '{{count}} awaiting reply', {
        count: replies.length
      })
    },
    {
      key: 'confirmations',
      items: confirmations,
      label: t(`${ENTRY}.timelinePendingConfirmations`, '{{count}} awaiting confirmation', {
        count: confirmations.length
      })
    },
    {
      key: 'unread',
      items: unread,
      label: t(`${ENTRY}.timelineUnreadResults`, '{{count}} unread results', {
        count: unread.length
      })
    }
  ].filter(({ items }) => items.length > 0)
  if (shortcuts.length === 0) {
    return null
  }
  return (
    <nav
      aria-label={t(`${ENTRY}.timelinePending`, 'Timeline items to review')}
      className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2"
    >
      {shortcuts.map(({ key, items, label }) => (
        <TimelineJumpMenu key={key} items={items} label={label} onSelect={onSelect} />
      ))}
    </nav>
  )
}
