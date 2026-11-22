import { Clock3 } from 'lucide-react'
import { EntryDeleteButton } from './entry-delete-button'
import { ENTRY_MESSAGE_SURFACE, EntryMessageHeader, EntryMessageText } from './entry-message'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { RoutingEntrySubAction } from '../workspace-card/activity/routing-entry-model'
import { agentMarkOf, displayNameOf } from './entry-task-view'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

export function entryAssignmentPresentation(action: RoutingEntrySubAction, t: Translate) {
  return action.assignmentFailed
    ? { status: t(`${ENTRY}.dispatchFailed`, 'Dispatch failed'), tone: 'error' as const }
    : { status: t(`${ENTRY}.assignHead`, 'Needs your assignment'), tone: 'warning' as const }
}

/** The 原型 .assign-card: an unassigned sub-action awaiting a manual worker pick. */
export function EntryAssignCard({
  action,
  reason,
  embedded,
  busy,
  agents,
  onAssign,
  onDelete
}: {
  action: RoutingEntrySubAction
  reason?: string
  embedded?: boolean
  busy?: boolean
  agents?: TuiAgent[]
  onDelete?: () => void
  onAssign?: (subActionId: string, agent: TuiAgent) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <article
      id={embedded ? undefined : `entry-task-${action.subActionId}`}
      className={`${ENTRY_MESSAGE_SURFACE} overflow-hidden`}
    >
      <div className="px-3 py-2.5">
        <EntryMessageHeader {...entryAssignmentPresentation(action, t)} />
        <EntryMessageText as="h4" text={action.text} className="font-medium" />
        {onDelete ? (
          <EntryDeleteButton scope="sub-action" disabled={busy} onDelete={onDelete} />
        ) : null}
      </div>
      {action.assignmentError || reason ? (
        <div className="px-3 pb-2">
          <EntryMessageText
            text={action.assignmentError ?? reason ?? ''}
            className="text-muted-foreground"
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-1 px-2 pb-1">
        {(agents ?? []).length > 0 ? (
          (agents ?? []).map((agent) => (
            <button
              key={agent}
              type="button"
              disabled={busy || !onAssign}
              className="flex w-full items-center gap-2.5 rounded-lg border bg-background px-2.5 py-2 text-start transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-60"
              onClick={() => onAssign?.(action.subActionId, agent)}
            >
              <span className="grid size-[22px] shrink-0 place-items-center rounded-md bg-secondary font-mono text-3xs font-bold text-foreground">
                {agentMarkOf(agent)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-settings-detail font-medium">
                  {displayNameOf(agent)}
                </span>
              </span>
            </button>
          ))
        ) : (
          <p className="px-2.5 py-2 text-2xs text-muted-foreground">
            {t(`${ENTRY}.noAgents`, 'No workers detected on this project host.')}
          </p>
        )}
      </div>
      <div className="flex items-start gap-1.5 px-3 pb-2.5 text-2xs text-muted-foreground">
        <Clock3 className="mt-px size-3 shrink-0" />
        <span>{t(`${ENTRY}.assignNote`, 'Pick a worker to dispatch this requirement.')}</span>
      </div>
    </article>
  )
}
