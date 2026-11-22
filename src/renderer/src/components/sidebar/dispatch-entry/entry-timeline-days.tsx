import { useState, type ReactNode } from 'react'
import { CalendarDays, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { EntryTimelineStatusBadge } from './entry-timeline-status-badge'
import type { EntryTimelineStatusCounts } from './entry-timeline-status'
import type { EntryTimelineDay } from './entry-timeline-events'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

const dayHeader =
  'flex min-h-9 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-1.5 text-sm font-medium'

function TimelineDayStatuses({
  counts
}: {
  counts: EntryTimelineStatusCounts
}): React.JSX.Element | null {
  if (!counts.running && !counts.queued && !counts.reply) {
    return null
  }
  return (
    <span className="ms-auto flex flex-wrap items-center gap-1">
      {counts.running > 0 ? (
        <EntryTimelineStatusBadge status="running" count={counts.running} />
      ) : null}
      {counts.queued > 0 ? (
        <EntryTimelineStatusBadge status="queued" count={counts.queued} />
      ) : null}
      {counts.reply > 0 ? <EntryTimelineStatusBadge status="reply" count={counts.reply} /> : null}
    </span>
  )
}

function TimelineDisclosure({
  label,
  countLabel,
  statusCounts,
  children
}: {
  label: string
  countLabel: string
  statusCounts: EntryTimelineStatusCounts
  children: ReactNode
}): React.JSX.Element {
  return (
    <details data-entry-timeline-disclosure="" className="[&[open]>summary>svg]:rotate-90">
      <summary
        className={cn(
          dayHeader,
          'cursor-pointer list-none border-border bg-muted/65 text-chat-foreground-strong hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden'
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none rtl:rotate-180"
        />
        <span className="flex min-w-0 flex-[1_1_auto] flex-wrap items-center gap-x-2">
          <span>{label}</span>
          <span className="ms-auto text-xs font-normal text-muted-foreground">{countLabel}</span>
        </span>
        <TimelineDayStatuses counts={statusCounts} />
      </summary>
      <div className="pt-3">{children}</div>
    </details>
  )
}

export function EntryTimelineDays({
  days,
  renderRow
}: {
  days: EntryTimelineDay[]
  renderRow: (row: EntryTimelineDay['rows'][number], lastOfDay: boolean) => ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const activityDays = days.filter((day) => day.rows.length > 0)
  const latestDay = activityDays.at(-1)
  const [liveDays, setLiveDays] = useState<ReadonlySet<number | null>>(() => new Set())
  if (latestDay && !liveDays.has(latestDay.day)) {
    // Keep the day the reader was looking at in place when a new date arrives.
    setLiveDays(new Set(liveDays).add(latestDay.day))
  }
  const liveStart = Math.min(...Array.from(liveDays, (day) => day ?? -Infinity))
  const archivedDays = activityDays.filter(
    ({ day, isArchived }) => isArchived && (day ?? -Infinity) < liveStart
  )
  const recentDays = activityDays.slice(archivedDays.length)

  function eventCountLabel(count: number): string {
    return t(`${ENTRY}.timelineEventCount`, '{{count}} activities', { count })
  }

  function renderDay(group: EntryTimelineDay): React.JSX.Element {
    const { day, label, isToday, rows, statusCounts } = group
    const dateLabel = label ?? t(`${ENTRY}.timelineUndated`, 'Unknown date')
    const rowList = rows.map((row, index) => renderRow(row, index === rows.length - 1))
    if (!isToday && !liveDays.has(day)) {
      return (
        <TimelineDisclosure
          key={day ?? 'undated'}
          label={dateLabel}
          countLabel={eventCountLabel(rows.length)}
          statusCounts={statusCounts}
        >
          {rowList}
        </TimelineDisclosure>
      )
    }

    return (
      <div key={day ?? 'undated'}>
        <h2
          className={cn(
            dayHeader,
            'sticky top-0 z-20 mb-3 border-border bg-card text-card-foreground shadow-xs'
          )}
        >
          <CalendarDays aria-hidden="true" className="size-4 shrink-0" />
          <span className="font-semibold">
            {isToday ? t(`${ENTRY}.timelineToday`, 'Today') : dateLabel}
          </span>
          {isToday ? (
            <span className="text-xs font-normal text-muted-foreground">{label}</span>
          ) : null}
          <TimelineDayStatuses counts={statusCounts} />
        </h2>
        {rowList}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2.5">
      {archivedDays.length > 0 ? (
        <TimelineDisclosure
          label={t(`${ENTRY}.timelineEarlierActivity`, 'Earlier activity')}
          statusCounts={archivedDays.reduce(
            (total, { statusCounts }) => ({
              running: total.running + statusCounts.running,
              queued: total.queued + statusCounts.queued,
              reply: total.reply + statusCounts.reply
            }),
            { running: 0, queued: 0, reply: 0 }
          )}
          countLabel={eventCountLabel(
            archivedDays.reduce((count, day) => count + day.rows.length, 0)
          )}
        >
          <div className="ms-5 flex flex-col gap-2.5 border-s border-border ps-3">
            {archivedDays.map(renderDay)}
          </div>
        </TimelineDisclosure>
      ) : null}
      {recentDays.map(renderDay)}
    </div>
  )
}
