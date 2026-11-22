import { CircleHelp } from 'lucide-react'
import { ENTRY_MESSAGE_SURFACE, EntryMessageHeader, EntryMessageText } from './entry-message'
import { useTranslate } from '@/i18n/use-translate'
import type { EntryClarification } from '../workspace-card/activity/entry-ledger-parsers'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

/** 统一路由动作批的待澄清项（§动作协议 clarify）：与查询答案、工作卡片同屏展示，等用户
 *  回答——回答走入口 composer 的新请求，独立且已授权的其他动作不受影响。 */
export function EntryClarifyList({ items }: { items: EntryClarification[] }): React.JSX.Element {
  const t = useTranslate()
  if (items.length === 0) {
    return <span data-entry-clarify-empty="" />
  }
  return (
    <>
      {items.map((item, index) => (
        <article key={item.key || index} className={`${ENTRY_MESSAGE_SURFACE} px-3 py-2.5`}>
          <EntryMessageHeader
            icon={CircleHelp}
            type={t(`${ENTRY}.messageRoutingQuestion`, 'Routing question')}
            status={t(`${ENTRY}.clarifyHead`, 'Needs your answer')}
            tone="warning"
          />
          <EntryMessageText text={item.question} />
        </article>
      ))}
    </>
  )
}
