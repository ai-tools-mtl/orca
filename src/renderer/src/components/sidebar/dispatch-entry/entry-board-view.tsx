import { ListChecks } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { EntryTaskFact } from './entry-task-facts'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

const LANES = [
  { id: 'idle', dot: 'bg-muted-foreground' },
  { id: 'queued', dot: 'bg-muted-foreground/60' },
  { id: 'attention', dot: 'bg-agent-question' },
  { id: 'working', dot: 'bg-agent-working' },
  { id: 'done', dot: 'bg-status-success' }
] as const

function laneLabel(
  t: (key: string, fallback: string) => string,
  lane: (typeof LANES)[number]['id']
): string {
  switch (lane) {
    case 'idle':
      return t(`${ENTRY}.boardIdle`, 'Idle')
    case 'queued':
      return t(`${ENTRY}.boardQueued`, 'Queued')
    case 'attention':
      return t(`${ENTRY}.boardNeedsYou`, 'Needs attention')
    case 'working':
      return t(`${ENTRY}.boardWorking`, 'Working')
    case 'done':
      return t(`${ENTRY}.boardDone`, 'Done')
  }
}

const STATE_DOT: Record<EntryTaskFact['state'], string> = {
  attention: 'bg-agent-question',
  working: 'bg-agent-working animate-pulse',
  queued: 'bg-muted-foreground/60',
  done: 'bg-status-success',
  failed: 'bg-status-warning',
  idle: 'bg-muted-foreground/45'
}

function LaneCard({
  fact,
  onSelect
}: {
  fact: EntryTaskFact
  onSelect: (fact: EntryTaskFact) => void
}): React.JSX.Element {
  const t = useTranslate()
  // 排队中的阶段还没有可跳的时间线任务卡——渲染为非交互卡。
  const selectable = fact.bucket !== 'queued'
  const body = (
    <>
      <span className="mb-1 flex items-center gap-1.5">
        <span className={`size-2 shrink-0 rounded-full ${STATE_DOT[fact.state]}`} />
        <span className="min-w-0 flex-1 truncate text-settings-detail font-semibold">
          {fact.title}
        </span>
        {selectable ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-3xs font-semibold tracking-wide text-muted-foreground">
            <ListChecks className="size-2.5" />
            {t(`${ENTRY}.boardTaskKind`, 'Task')}
          </span>
        ) : null}
      </span>
      <span className="block truncate font-mono text-3xs text-chat-foreground-faint">
        {[fact.agent, fact.worktreeName].filter(Boolean).join(' · ')}
      </span>
      {fact.preview ? (
        <span
          className={`mt-1.5 line-clamp-2 border-t pt-1.5 text-2xs ${fact.isQuestion ? 'text-agent-question' : 'text-muted-foreground'}`}
        >
          {fact.preview}
        </span>
      ) : null}
    </>
  )
  if (!selectable) {
    return (
      <div
        data-state={fact.state}
        className="mb-2 block w-full rounded-lg border border-dashed border-border bg-card/60 p-2.5 text-start"
      >
        {body}
      </div>
    )
  }
  return (
    <button
      type="button"
      data-state={fact.bucket === 'attention' ? 'attention' : fact.state}
      className={`mb-2 block w-full rounded-lg border bg-card p-2.5 pb-2.5 text-start shadow-xs transition-colors hover:bg-accent ${
        fact.bucket === 'attention'
          ? 'border-[color-mix(in_srgb,var(--agent-question)_40%,var(--border))]'
          : ''
      }`}
      onClick={() => onSelect(fact)}
    >
      {body}
    </button>
  )
}

/** The 原型 .board-view: lanes over the entry's own task cards (含排队中的阶段). */
export function EntryBoardView({
  facts,
  onSelect
}: {
  facts: readonly EntryTaskFact[]
  onSelect: (fact: EntryTaskFact) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
      <div className="grid grid-cols-2 items-start gap-2.5 px-4 py-3.5 min-[1100px]:grid-cols-4 min-[1400px]:grid-cols-5">
        {LANES.map((lane) => {
          const laneFacts = facts.filter((fact) => fact.bucket === lane.id)
          return (
            <section
              key={lane.id}
              aria-label={laneLabel(t, lane.id)}
              className="min-h-80 rounded-xl bg-secondary p-2"
            >
              <div className="flex items-center gap-1.5 px-1 pb-2 pt-0.5 text-2xs font-semibold tracking-wide">
                <span className={`size-[7px] shrink-0 rounded-full ${lane.dot}`} />
                {laneLabel(t, lane.id)}
                <span className="ml-auto font-mono text-3xs font-normal text-muted-foreground">
                  {laneFacts.length}
                </span>
              </div>
              {laneFacts.length === 0 ? (
                <p className="px-1.5 py-2.5 text-2xs text-muted-foreground/65">
                  {t(`${ENTRY}.boardLaneEmpty`, 'Empty')}
                </p>
              ) : (
                laneFacts.map((fact) => (
                  <LaneCard key={fact.subActionId} fact={fact} onSelect={onSelect} />
                ))
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
