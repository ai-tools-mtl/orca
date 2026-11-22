import { useCallback, useState } from 'react'
import { FileDiff, RefreshCw } from 'lucide-react'
import { diffLines } from 'diff'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslate } from '@/i18n/use-translate'
import { STATUS_COLORS } from '@/lib/source-control/paths/git-path-decoration'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import { getRuntimeGitDiff } from '@/runtime/source-control/git/runtime-git-diff-client'
import { getRuntimeGitStatus } from '@/runtime/source-control/git/runtime-git-status-client'
import type { GitStatusEntry } from '../../../../../shared/git/status/git-status-types'
import { STATUS_LABELS } from '../../../../../shared/git/status/git-status-labels'
import { getFileExplorerOwnerUnresolvedMessage } from '../file-explorer/navigation/file-explorer-operation-owner'
import { DispatchWorktreePreview, type DispatchPreview } from './dispatch-worktree-preview'
import { DispatchWorktreeReadState } from './dispatch-worktree-read-state'
import { useDispatchSidebarRead } from './use-dispatch-sidebar-read'

const PREVIEW_LIMIT = 6000

function ChangeRow({ context, entry }: { context: RuntimeGitContext; entry: GitStatusEntry }) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const { path, area, oldPath, conflictKind, conflictStatus, submodule, submoduleRoot } = entry
  const read = useCallback(async (): Promise<DispatchPreview> => {
    if ((conflictKind && conflictStatus !== 'resolved_locally') || submodule || submoduleRoot) {
      return { unavailable: true }
    }
    const diff = await getRuntimeGitDiff(
      context,
      {
        filePath: path,
        staged: area === 'staged',
        oldPath
      },
      { wakeWslDistro: true }
    )
    if (diff.kind !== 'text') {
      return { unavailable: true }
    }
    const parts = diffLines(
      diff.originalContent.slice(0, PREVIEW_LIMIT),
      diff.modifiedContent.slice(0, PREVIEW_LIMIT),
      { timeout: 50 }
    )
    if (!parts) {
      return { unavailable: true }
    }
    const lines = parts
      .filter((part) => part.added || part.removed)
      .flatMap((part) =>
        part.value
          .replace(/\n$/, '')
          .split('\n')
          .map((line) => `${part.added ? '+' : '-'} ${line}`)
      )
      .join('\n')
    const truncated =
      lines.length > PREVIEW_LIMIT ||
      diff.originalContent.length > PREVIEW_LIMIT ||
      diff.modifiedContent.length > PREVIEW_LIMIT
    return { text: lines.slice(0, PREVIEW_LIMIT), truncated }
  }, [area, conflictKind, conflictStatus, context, oldPath, path, submodule, submoduleRoot])
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full min-w-0 justify-start gap-1.5 px-1.5 text-xs"
        >
          <FileDiff className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-start" title={path}>
            {path}
          </span>
          {area === 'staged' ? (
            <span className="text-2xs text-muted-foreground">
              {t('auto.components.rightSidebar.DispatchWorktrees.staged', 'Staged')}
            </span>
          ) : null}
          <span
            className="w-3 text-center font-medium"
            style={{ color: STATUS_COLORS[entry.status] }}
          >
            {STATUS_LABELS[entry.status]}
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <DispatchWorktreePreview path={path} read={read} onClose={() => setOpen(false)} />
      </CollapsibleContent>
    </Collapsible>
  )
}

export function DispatchWorktreeChanges({
  context,
  folder
}: {
  context: RuntimeGitContext | null
  folder: boolean
}): React.JSX.Element {
  const t = useTranslate()
  if (folder || !context) {
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground">
        {folder
          ? t(
              'auto.components.rightSidebar.DispatchWorktrees.folderChanges',
              'This folder has no Git changes to show.'
            )
          : getFileExplorerOwnerUnresolvedMessage()}
      </p>
    )
  }
  return <GitChanges context={context} />
}

function GitChanges({ context }: { context: RuntimeGitContext }): React.JSX.Element {
  const t = useTranslate()
  const read = useCallback(
    async (signal: AbortSignal) => {
      const status = await getRuntimeGitStatus(context, {
        signal,
        includeLineStats: false,
        admissionTier: 'interactive',
        wakeWslDistro: true
      })
      if (status.readError) {
        throw new Error(status.readError)
      }
      return status
    },
    [context]
  )
  const { result, refresh } = useDispatchSidebarRead(read)
  if (!result?.value) {
    return <DispatchWorktreeReadState error={result?.error} onRetry={refresh} />
  }
  const { entries, didHitLimit } = result.value
  return (
    <>
      <div className="flex items-center justify-between gap-1 ps-1 text-xs text-muted-foreground">
        <span>
          {t('auto.components.rightSidebar.DispatchWorktrees.uncommitted', 'Uncommitted changes')}
        </span>
        <Button
          size="icon-xs"
          type="button"
          variant="ghost"
          aria-label={t(
            'auto.components.rightSidebar.DispatchWorktrees.refreshChanges',
            'Refresh changes'
          )}
          onClick={refresh}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      {entries.map((entry) => (
        <ChangeRow key={JSON.stringify([entry.area, entry.path])} entry={entry} context={context} />
      ))}
      {didHitLimit ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          {t(
            'auto.components.rightSidebar.DispatchWorktrees.changesLimited',
            'Only the first changes are shown.'
          )}
        </p>
      ) : !entries.length ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          {t(
            'auto.components.rightSidebar.DispatchWorktrees.emptyChanges',
            'No uncommitted changes.'
          )}
        </p>
      ) : null}
    </>
  )
}
