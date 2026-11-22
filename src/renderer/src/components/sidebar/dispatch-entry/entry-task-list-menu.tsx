import { useState } from 'react'
import { ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { entryFactAgentLabel, type EntryTaskFact } from './entry-task-facts'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

const STATE_DOT: Record<EntryTaskFact['state'], string> = {
  attention: 'bg-agent-question',
  working: 'bg-agent-working',
  queued: 'bg-muted-foreground/60',
  done: 'bg-status-success',
  failed: 'bg-status-warning',
  idle: 'bg-muted-foreground'
}

function stateLabel(
  t: (key: string, fallback: string) => string,
  state: EntryTaskFact['state']
): string {
  switch (state) {
    case 'attention':
      return t(`${ENTRY}.workerAttention`, 'Needs attention')
    case 'working':
      return t(`${ENTRY}.workerRunning`, 'Running')
    case 'queued':
      return t(`${ENTRY}.boardQueued`, 'Queued')
    case 'done':
      return t(`${ENTRY}.workerCompleted`, 'Completed')
    case 'failed':
      return t(`${ENTRY}.workerFailed`, 'Failed')
    case 'idle':
      return t(`${ENTRY}.awaitingRouting`, 'Awaiting routing')
  }
}

/** The 原型 .task-dd: every entry task with its workspace and state, locating on click. */
export function EntryTaskListMenu({
  facts,
  onSelect
}: {
  facts: readonly EntryTaskFact[]
  onSelect: (fact: EntryTaskFact) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const label = t(`${ENTRY}.taskList`, 'Task list')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={`${label} (${facts.length})`}
              className="gap-1.5 text-muted-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
            >
              <ListChecks aria-hidden="true" className="size-4" />
              <span aria-hidden="true" className="text-2xs font-normal tabular-nums">
                {facts.length}
              </span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="scrollbar-sleek max-h-[46vh] w-[460px] max-w-(--radix-popover-content-available-width) overflow-y-auto p-1.5"
      >
        {facts.length === 0 ? (
          <p className="px-2.5 py-4 text-center text-2xs text-muted-foreground">
            {t(`${ENTRY}.taskListEmpty`, 'No tasks yet · start from the input below')}
          </p>
        ) : (
          facts.map((fact) => (
            <button
              key={fact.subActionId}
              type="button"
              className="grid w-full grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-lg px-2 py-1.5 text-start transition-colors hover:bg-accent"
              onClick={() => {
                setOpen(false)
                onSelect(fact)
              }}
            >
              <span className={`size-2 rounded-full ${STATE_DOT[fact.state]}`} />
              <span className="truncate text-xs font-medium">{fact.title}</span>
              <span className="whitespace-nowrap text-3xs text-muted-foreground">
                {stateLabel(t, fact.state)}
                {entryFactAgentLabel(fact) ? ` · ${entryFactAgentLabel(fact)}` : ''}
              </span>
              <span className="col-start-2 truncate font-mono text-3xs text-muted-foreground">
                {fact.worktreeName ?? fact.subActionId}
              </span>
            </button>
          ))
        )}
      </PopoverContent>
    </Popover>
  )
}
