import { MessageCircleQuestion } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

/** The 澄清回复 composer mode: armed while a worker's ask awaits — what the user types in the
 *  main composer IS the answer (entryAnswerAsk), not a new request. Toggling off sends new
 *  work instead; a fresh ask re-arms it. */
export function EntryAskChip({
  on,
  askCount,
  onToggle
}: {
  on: boolean
  askCount: number
  onToggle: (next: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const count = askCount > 1 ? ` ×${askCount}` : ''
  return (
    <button
      type="button"
      aria-pressed={on}
      className={`inline-flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-2xs font-medium transition-colors ${
        on
          ? 'border-status-warning-border bg-status-warning-background text-status-warning-text'
          : 'border-dashed border-border text-muted-foreground hover:bg-secondary hover:text-foreground'
      }`}
      onClick={() => onToggle(!on)}
    >
      <MessageCircleQuestion className="size-3" />
      {on
        ? t(`${ENTRY}.askChipOn`, 'Clarify · your text answers the pending question')
        : t(`${ENTRY}.askChip`, 'Reply to clarification') + count}
    </button>
  )
}
