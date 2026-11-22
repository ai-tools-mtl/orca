import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'

export function DispatchWorktreeReadState({
  error,
  onRetry
}: {
  error: string | undefined
  onRetry: () => void
}): React.JSX.Element {
  const t = useTranslate()
  if (error === undefined) {
    return (
      <p role="status" className="px-2 py-1.5 text-xs text-muted-foreground">
        {t('auto.components.rightSidebar.DispatchWorktrees.loading', 'Loading…')}
      </p>
    )
  }
  return (
    <div className="space-y-1 px-2 py-1.5">
      <p role="alert" className="text-xs text-destructive [overflow-wrap:anywhere]">
        {error}
      </p>
      <Button type="button" size="xs" variant="outline" onClick={onRetry}>
        {t('common.retry', 'Retry')}
      </Button>
    </div>
  )
}
