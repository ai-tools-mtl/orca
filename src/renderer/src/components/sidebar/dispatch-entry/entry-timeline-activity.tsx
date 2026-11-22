import { FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type {
  RoutingEntryApproval,
  RoutingEntrySubAction
} from '../workspace-card/activity/routing-entry-model'
import { EntryAskCard } from './entry-ask-card'
import { ENTRY_MESSAGE_SURFACE, EntryMessageHeader, EntryMessageText } from './entry-message'
import { EntryStageCheckpoint } from './entry-stage-checkpoint'
import { displayNameOf } from './entry-task-view'
import type { EntryTimelineEvent } from './entry-timeline-events'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

export function EntryTimelineActivity({
  event,
  showFullResult,
  lastOfDay,
  busy,
  isUnread,
  locate,
  markSeen,
  answerAsk,
  grantGate,
  rejectGate,
  renderApproval,
  onActionError
}: {
  event: Exclude<EntryTimelineEvent, { kind: 'request' }>
  showFullResult?: boolean
  lastOfDay: boolean
  busy: boolean
  isUnread: (action: RoutingEntrySubAction) => boolean
  locate: (id: string) => void
  markSeen: (action: RoutingEntrySubAction) => void
  answerAsk: (messageId: string, body: string) => Promise<unknown>
  grantGate: (subActionId: string) => Promise<unknown>
  rejectGate?: (subActionId: string, text: string) => Promise<unknown>
  renderApproval: (approval: RoutingEntryApproval, context?: React.ReactNode) => React.JSX.Element
  onActionError: (error: string | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const owner = event.kind === 'approval' ? event.owner : event
  const context = owner ? (
    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2">
      <EntryMessageText text={owner.action.text} as="h4" className="font-medium" />
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        onClick={() => locate(`entry-request-${owner.input.inputId}`)}
      >
        {t(`${ENTRY}.timelineViewRequest`, 'View original request')}
      </Button>
    </div>
  ) : undefined

  function renderCard(): React.JSX.Element {
    if (event.kind === 'approval') {
      return (
        <div className={`${ENTRY_MESSAGE_SURFACE} overflow-hidden`}>
          {renderApproval(event.approval, context)}
        </div>
      )
    }
    const { action } = event
    const agent = action.execution?.agent ?? action.agentHint
    if (event.kind === 'ask') {
      const { ask } = event
      const answered = 'answer' in ask
      return (
        <EntryAskCard
          question={answered ? ask.question : ask.body}
          answer={answered ? ask.answer : undefined}
          answeredAt={answered ? ask.answeredAt : undefined}
          context={context}
          agent={
            !ask.dispatchId || ask.dispatchId === action.execution?.dispatchId ? agent : undefined
          }
          busy={busy}
          onAnswer={answered ? undefined : (body) => answerAsk(ask.messageId, body)}
          onActionError={onActionError}
        />
      )
    }
    const unread = isUnread(action)
    const seenButton = unread ? (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="mt-1 text-muted-foreground"
        onClick={() => markSeen(action)}
      >
        {t(`${ENTRY}.timelineMarkRead`, 'Mark as read')}
      </Button>
    ) : null
    if (event.kind === 'checkpoint') {
      return (
        <>
          <EntryStageCheckpoint
            action={action}
            state={event.state}
            busy={busy}
            context={context}
            onGrant={() => {
              onActionError(null)
              void grantGate(action.subActionId).catch((error: unknown) =>
                onActionError(String(error))
              )
            }}
            onReject={
              rejectGate
                ? (text) => {
                    onActionError(null)
                    return rejectGate(action.subActionId, text).catch((error: unknown) => {
                      onActionError(String(error))
                      throw error
                    })
                  }
                : undefined
            }
          />
          {event.state === 'merged' || event.state === 'merge-failed' ? seenButton : null}
        </>
      )
    }
    const { execution, failed } = event
    const primaryText = failed ? execution.failure : execution.result
    const secondaryText = failed ? execution.result : execution.failure
    return (
      <article className={`${ENTRY_MESSAGE_SURFACE} px-3 py-2.5`}>
        <EntryMessageHeader
          icon={FileText}
          type={t(`${ENTRY}.timelineResult`, 'Task result')}
          sender={agent ? displayNameOf(agent) : undefined}
          status={
            failed
              ? t(`${ENTRY}.failedEvent`, 'Execution failed')
              : t(`${ENTRY}.workerCompleted`, 'Completed')
          }
          tone={failed ? 'error' : 'success'}
        />
        {context}
        {primaryText ? (
          <EntryMessageText
            text={primaryText}
            showFullText={showFullResult}
            unreadLabel={unread ? t(`${ENTRY}.unreadLabel`, 'New result') : undefined}
            onExpand={unread ? () => markSeen(action) : undefined}
          />
        ) : null}
        {secondaryText ? (
          <EntryMessageText
            text={secondaryText}
            showFullText={showFullResult}
            className={failed ? 'mt-1' : 'mt-1 text-destructive'}
          />
        ) : null}
        {seenButton}
      </article>
    )
  }

  return (
    <div className="grid grid-cols-[3rem_1rem_minmax(0,1fr)] gap-x-1.5">
      {event.at ? (
        <time
          dateTime={event.at.toISOString()}
          className="col-start-1 row-start-1 pt-3 text-xs tabular-nums text-chat-foreground-faint"
        >
          {event.at.toLocaleTimeString(locale, {
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
          })}
        </time>
      ) : null}
      <div className="relative col-start-2 row-start-1 pt-3" aria-hidden="true">
        <span className="relative z-10 ms-1.5 mt-1.5 block size-1.5 rounded-full bg-muted-foreground" />
        {lastOfDay ? null : <span className="absolute start-1/2 top-5 bottom-0 w-px bg-border" />}
      </div>
      <div
        id={event.id}
        tabIndex={-1}
        className="col-start-3 row-start-1 min-w-0 rounded-xl mb-3 focus-visible:outline-2 focus-visible:outline-ring"
      >
        {renderCard()}
      </div>
    </div>
  )
}
