import { useState } from 'react'
import { CircleHelp, CornerDownRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { ENTRY_MESSAGE_SURFACE, EntryMessageHeader, EntryMessageText } from './entry-message'
import { displayNameOf, entryDateOf } from './entry-task-view'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

/** 编号问题分点渲染：worker 常把 N）N. N、形态的提问挤成一段——单段长文在编号标记前断行
 *  （lookbehind 排除小数/版本号），作者已分行的尊重原文，逐条留出呼吸感。 */
function askParagraphsOf(body: string): string[] {
  const splitNumbered = (text: string): string[] => {
    const parts = text
      .split(/(?<!\d)(?=\d{1,2}[）)]\s?|\d{1,2}[.、]\s)/u)
      .map((part) => part.trim())
      .filter(Boolean)
    return parts.length > 1 ? parts : [text]
  }
  const lines = body
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length > 1 ? lines.flatMap(splitNumbered) : splitNumbered(body)
}

export function EntryAskCard({
  question,
  answer,
  answeredAt,
  context,
  agent,
  busy,
  onAnswer,
  onActionError
}: {
  question: string
  answer?: string
  answeredAt?: string
  context?: React.ReactNode
  agent?: string | null
  busy?: boolean
  onAnswer?: (body: string) => Promise<unknown>
  onActionError: (message: string | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const replyDate = entryDateOf(answeredAt)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const answered = answer !== undefined

  async function send(): Promise<void> {
    const body = draft.trim()
    if (!body || busy || sending || !onAnswer) {
      return
    }
    setSending(true)
    onActionError(null)
    try {
      await onAnswer(body)
      setDraft('')
    } catch (error) {
      onActionError(String(error))
    } finally {
      setSending(false)
    }
  }

  return (
    <article className={`${ENTRY_MESSAGE_SURFACE} px-3 py-2.5`}>
      <EntryMessageHeader
        icon={CircleHelp}
        type={t(`${ENTRY}.messageAgentQuestion`, 'Agent question')}
        sender={agent ? displayNameOf(agent) : undefined}
        status={
          answered
            ? t(`${ENTRY}.askAnsweredPrefix`, 'Answered')
            : t(`${ENTRY}.timelineAwaitingReply`, 'Awaiting reply')
        }
        activity={answered ? undefined : 'reply'}
        tone={answered ? 'neutral' : 'warning'}
      />
      {context}
      <EntryMessageText text={askParagraphsOf(question).join('\n')} />
      {answered ? (
        <div className="mt-2 space-y-1 border-t border-border pt-2">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <CornerDownRight className="size-3.5" aria-hidden="true" />
            {t(`${ENTRY}.messageYourReply`, 'Your reply')}
            {replyDate ? (
              <time dateTime={replyDate.toISOString()} className="font-normal tabular-nums">
                {replyDate.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })}
              </time>
            ) : null}
          </p>
          <EntryMessageText text={answer} />
        </div>
      ) : (
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <Input
            className="min-w-0"
            value={draft}
            aria-label={t(`${ENTRY}.askSend`, 'Reply')}
            placeholder={t(
              `${ENTRY}.askReplyPlaceholder`,
              'Reply to this question — the worker will continue once it arrives'
            )}
            onChange={(event) => setDraft(event.target.value)}
            readOnly={sending}
          />
          <Button type="submit" size="xs" disabled={!draft.trim() || busy || sending}>
            {t(`${ENTRY}.askSend`, 'Reply')}
          </Button>
        </form>
      )}
    </article>
  )
}
