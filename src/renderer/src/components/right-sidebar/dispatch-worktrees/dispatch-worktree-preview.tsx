import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { DispatchWorktreeReadState } from './dispatch-worktree-read-state'
import { useDispatchSidebarRead } from './use-dispatch-sidebar-read'

export type DispatchPreview = { text: string; truncated?: boolean } | { unavailable: true }

export function DispatchWorktreePreview({
  path,
  read,
  onClose
}: {
  path: string
  read: (signal: AbortSignal) => Promise<DispatchPreview>
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { result, refresh } = useDispatchSidebarRead(read)
  return (
    <section aria-label={path} className="my-1.5 min-w-0 rounded-lg border bg-background">
      <div className="flex items-start justify-between gap-1.5 border-b ps-2 pe-1">
        <h4 className="min-w-0 py-1.5 text-xs font-medium [overflow-wrap:anywhere]">{path}</h4>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          aria-label={t(
            'auto.components.rightSidebar.DispatchWorktrees.closePreview',
            'Close preview'
          )}
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {!result?.value ? (
        <DispatchWorktreeReadState error={result?.error} onRetry={refresh} />
      ) : 'unavailable' in result.value ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          {t(
            'auto.components.rightSidebar.DispatchWorktrees.previewUnavailable',
            'No inline preview for this file.'
          )}
        </p>
      ) : (
        <>
          <pre className="scrollbar-sleek max-h-52 overflow-auto p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
            {result.value.text}
          </pre>
          {result.value.truncated ? (
            <p className="border-t px-2 py-1.5 text-xs text-muted-foreground">
              {t(
                'auto.components.rightSidebar.DispatchWorktrees.previewTruncated',
                'Preview truncated'
              )}
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}
