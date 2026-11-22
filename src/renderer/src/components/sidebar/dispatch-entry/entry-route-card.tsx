import { ChevronDown, ChevronRight, CircleHelp, Rewind, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslate } from '@/i18n/use-translate'
import type { RoutingEntryInput } from '../workspace-card/activity/routing-entry-model'
import { flashEntryElement } from './entry-task-view'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

export function EntryRouteCard({ input }: { input: RoutingEntryInput }): React.JSX.Element {
  const t = useTranslate()
  const dispatched = input.subActions.every(
    (action) => !action.resumed && action.execution && action.execution.status !== 'pending'
  )
  const completed = input.subActions.every(
    (action) => !action.resumed && action.execution?.status === 'completed'
  )
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="group h-auto max-w-full flex-wrap justify-start gap-1.5 px-1 py-1 text-xs text-muted-foreground"
        >
          <span>{t(`${ENTRY}.registered`, 'Received')}</span>
          <ChevronRight aria-hidden="true" className="size-3" />
          <span>
            {t(`${ENTRY}.subActionCount`, '{{count}} sub-actions', {
              count: input.subActions.length
            })}
          </span>
          {dispatched ? (
            <>
              <ChevronRight aria-hidden="true" className="size-3" />
              <span>{t(`${ENTRY}.routeDispatched`, 'Dispatched')}</span>
            </>
          ) : null}
          {completed ? (
            <>
              <ChevronRight aria-hidden="true" className="size-3" />
              <span>{t(`${ENTRY}.boardDone`, 'Done')}</span>
            </>
          ) : null}
          <ChevronDown aria-hidden="true" className="size-3 group-data-[state=open]:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 space-y-1 border-s border-border ps-3">
        {input.decisionReason ? (
          <p className="text-sm break-words whitespace-pre-wrap text-muted-foreground">
            {input.decisionReason}
          </p>
        ) : null}
        <p className="font-mono text-2xs break-all text-muted-foreground">{input.inputId}</p>
        {input.subActions.map((action, index) => {
          const reference = input.taskReferences?.[index]
          const taskId = reference ?? action.taskId
          const goLabel = reference
            ? t(`${ENTRY}.routeResume`, 'Resume')
            : taskId
              ? t(`${ENTRY}.routeNew`, 'New task')
              : t(`${ENTRY}.routeAssign`, 'Awaiting assignment')
          const Icon = reference ? Rewind : taskId ? Sparkles : CircleHelp
          const content = (
            <>
              <span className="pt-0.5 tabular-nums text-muted-foreground">{index + 1}</span>
              <span className="min-w-0 space-y-1 whitespace-normal">
                <span className="block [overflow-wrap:anywhere]">{action.text}</span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <Icon className="size-3 shrink-0" aria-hidden="true" />
                    {goLabel}
                  </span>
                  {taskId ? (
                    <span className="min-w-0 font-mono text-2xs break-all">{taskId}</span>
                  ) : null}
                </span>
              </span>
            </>
          )
          return taskId ? (
            <Button
              key={action.subActionId}
              type="button"
              variant="ghost"
              size="sm"
              className="grid h-auto w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 px-2 py-1.5 text-start"
              onClick={(event) => {
                const stream = event.currentTarget.closest('[data-dispatch-entry-stream]')
                flashEntryElement(
                  stream?.querySelector(
                    reference
                      ? `[data-entry-task-id="${CSS.escape(reference)}"]`
                      : `#entry-task-${CSS.escape(action.subActionId)}`
                  ) ?? null
                )
              }}
            >
              {content}
            </Button>
          ) : (
            <div
              key={action.subActionId}
              className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 px-2 py-1.5 text-sm"
            >
              {content}
            </div>
          )
        })}
      </CollapsibleContent>
    </Collapsible>
  )
}
