import { Undo2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

/** The 驳回修改 composer mode chip: armed while a stage gate awaits — what the user types in
 *  the main composer IS the rejection's modification request (entryGateReject), not a new
 *  request. Toggling off sends new work instead; a fresh waiting gate re-arms it. */
export function EntryGateChip({
  on,
  gateCount,
  onToggle
}: {
  on: boolean
  gateCount: number
  onToggle: (next: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const count = gateCount > 1 ? ` ×${gateCount}` : ''
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
      <Undo2 className="size-3" />
      {on
        ? t(`${ENTRY}.gateChipOn`, 'Reject & rework · your text goes back to the worker')
        : t(`${ENTRY}.gateChip`, 'Reply to the pending gate') + count}
    </button>
  )
}
