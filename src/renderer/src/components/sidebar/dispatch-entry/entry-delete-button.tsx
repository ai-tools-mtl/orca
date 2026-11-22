import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

export function EntryDeleteButton({
  disabled,
  scope,
  onDelete
}: {
  disabled?: boolean
  scope: 'request' | 'sub-action' | 'failed'
  onDelete: () => void
}): React.JSX.Element {
  const t = useTranslate()
  if (scope === 'failed') {
    const label = t(`${ENTRY}.deleteFailedInstructions`, 'Clear failed items')
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            className="text-muted-foreground hover:text-destructive"
            disabled={disabled}
            onClick={onDelete}
          >
            <Trash2 aria-hidden="true" className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    )
  }
  const label =
    scope === 'request'
      ? t(`${ENTRY}.deleteRequest`, 'Delete request')
      : t(`${ENTRY}.deleteInstruction`, 'Delete instruction')
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="text-destructive hover:text-destructive"
      disabled={disabled}
      onClick={onDelete}
    >
      <Trash2 aria-hidden="true" className="size-3" />
      {label}
    </Button>
  )
}
