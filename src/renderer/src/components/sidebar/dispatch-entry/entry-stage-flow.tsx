import { useTranslate, type Translate } from '@/i18n/use-translate'
import { ENTRY_MESSAGE_SURFACE, EntryMessageHeader, EntryMessageText } from './entry-message'
import { displayNameOf, isEntryStageWaitingForDispatch } from './entry-task-view'
import { entryTimelineTaskStatus } from './entry-timeline-status'
import type {
  RoutingEntryInput,
  RoutingEntrySubAction
} from '../workspace-card/activity/routing-entry-model'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

/** 侧标签只放短名：阶段文本是"名：描述"形态的长规格，全量塞进窄标签会被 flex 压成一列一字。 */
function stageLabelTitle(text: string): string {
  const head = (text.split(/[：:]/, 1)[0] ?? '').trim()
  const title = head.length > 0 ? head : text
  return title.length > 16 ? `${title.slice(0, 16)}…` : title
}

export function entryStageWaitOf(
  action: RoutingEntrySubAction,
  siblings: RoutingEntrySubAction[],
  t: Translate
) {
  let status = t(`${ENTRY}.stageWaiting`, 'Awaiting auto-dispatch')
  let tone: 'warning' | undefined
  let dependency: string | undefined
  for (const id of action.dependsOn ?? []) {
    const upstream = siblings.find((sibling) => sibling.subActionId === id)
    if (!upstream?.stageKind) {
      continue
    }
    if (!upstream.execution?.completedAt) {
      status = t(`${ENTRY}.boardQueued`, 'Queued')
    } else if (upstream.planUnusable) {
      status = t(`${ENTRY}.stagePlanBroken`, 'Plan not usable')
      tone = 'warning'
    } else if (upstream.gate === 'user_confirm' && !upstream.gateGrantedAt) {
      status = t(`${ENTRY}.messageAwaitingConfirmation`, 'Awaiting confirmation')
      tone = 'warning'
    } else {
      continue
    }
    dependency = stageLabelTitle(upstream.text)
    break
  }
  return {
    status,
    tone,
    dependency,
    sender: action.agentHint ? displayNameOf(action.agentHint) : undefined,
    activity: entryTimelineTaskStatus(action, false)
  }
}

export function EntryStageWaitCard({
  action,
  wait,
  embedded
}: {
  action: RoutingEntrySubAction
  wait: ReturnType<typeof entryStageWaitOf>
  embedded?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const { dependency, ...presentation } = wait
  return (
    <article
      id={embedded ? undefined : `entry-task-${action.subActionId}`}
      tabIndex={-1}
      className={`${ENTRY_MESSAGE_SURFACE} px-3 py-2.5 focus-visible:outline-2 focus-visible:outline-ring`}
    >
      <EntryMessageHeader {...presentation} />
      <EntryMessageText as="h4" text={action.text} className="font-medium" />
      {dependency ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t(`${ENTRY}.messageDependency`, 'Prerequisite · {{title}}', { title: dependency })}
        </p>
      ) : null}
    </article>
  )
}

export function EntryStageFlow({ input }: { input: RoutingEntryInput }): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {input.subActions
        .filter((action) => !action.resumed && isEntryStageWaitingForDispatch(action))
        .map((action) => (
          <EntryStageWaitCard
            key={action.subActionId}
            action={action}
            wait={entryStageWaitOf(action, input.subActions, t)}
          />
        ))}
    </>
  )
}
