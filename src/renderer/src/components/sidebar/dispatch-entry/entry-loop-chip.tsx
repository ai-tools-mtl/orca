import { Zap } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

/** The 循环开发（本次） quick option: an unmistakable on/off pill — violet fill when armed,
 *  muted dashed when off. */
export function EntryLoopChip({
  on,
  onToggle
}: {
  on: boolean
  onToggle: (next: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <button
      type="button"
      aria-pressed={on}
      className={`inline-flex h-[26px] items-center gap-1.5 rounded-full border border-border px-2.5 text-2xs font-medium transition-colors ${
        on
          ? 'border-[color-mix(in_srgb,var(--ai-action-accent)_50%,var(--border))] bg-[color-mix(in_srgb,var(--ai-action-accent)_12%,transparent)] text-foreground'
          : 'border-dashed text-muted-foreground hover:bg-secondary hover:text-foreground'
      }`}
      onClick={() => onToggle(!on)}
    >
      <Zap className={`size-3 ${on ? 'fill-ai-action-accent text-ai-action-accent' : ''}`} />
      {on
        ? t(`${ENTRY}.loopChipOn`, 'Loop dev on · applies to this submission')
        : t(`${ENTRY}.loopChip`, 'Loop dev (this submission)')}
    </button>
  )
}
