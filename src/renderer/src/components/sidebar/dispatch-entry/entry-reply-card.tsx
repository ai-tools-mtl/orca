import { Bot } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { EntryQueryAnswer, EntryReply } from '../workspace-card/activity/entry-ledger-parsers'
import { ENTRY_MESSAGE_SURFACE, EntryMessageHeader, EntryMessageText } from './entry-message'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

/** 入口的一般回复（「已回复」卡）：路由模型的 reply 动作文本与 query_status 的确定性答案，
 *  代替原先塞在请求卡里的灰色 reason 段落——会话型请求在这里得到正面的对话回答。 */
export function EntryReplyCard({
  replies,
  queryAnswers,
  className
}: {
  replies?: EntryReply[]
  queryAnswers?: EntryQueryAnswer[]
  className?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const answerTexts = [
    ...(replies ?? []).map((reply) => reply.text),
    ...(queryAnswers ?? []).map((answer) => answer.answer)
  ]
  if (answerTexts.length === 0) {
    return null
  }
  return (
    <article className={cn(ENTRY_MESSAGE_SURFACE, 'px-3 py-2.5', className)}>
      <EntryMessageHeader
        icon={Bot}
        type={t(`${ENTRY}.messageReply`, 'Entry reply')}
        status={t(`${ENTRY}.replied`, 'Replied')}
        tone="neutral"
      />
      <div className="flex flex-col gap-1">
        {answerTexts.map((text, index) => (
          <EntryMessageText key={index} text={text} />
        ))}
      </div>
    </article>
  )
}
