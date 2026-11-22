import { useCallback, useState } from 'react'
import { ChevronDown, FileText, Folder } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslate } from '@/i18n/use-translate'
import { getRelativePathInsideRoot, joinPath } from '@/lib/path'
import { readRuntimeFileContent } from '@/runtime/files/reads/runtime-file-read-client'
import { getFileExplorerOperationRoute } from '../file-explorer/navigation/file-explorer-operation-owner'
import { readFileExplorerDirectory } from '../file-explorer/tree/file-explorer-directory-listing'
import { shouldIncludeFileExplorerEntry } from '../file-explorer/tree/file-explorer-entries'
import type { FileExplorerOperationOwner } from '../file-explorer/tree/file-explorer-types'
import type { FileExplorerDirMore } from '../file-explorer/tree/file-explorer-types'
import { DispatchWorktreeReadState } from './dispatch-worktree-read-state'
import { DispatchWorktreePreview, type DispatchPreview } from './dispatch-worktree-preview'
import { useDispatchSidebarRead } from './use-dispatch-sidebar-read'

type DirectoryProps = {
  worktreeId: string
  root: string
  path: string
  owner: FileExplorerOperationOwner
}

function FileRow({
  worktreeId,
  root,
  path,
  owner,
  name,
  isSymlink
}: DirectoryProps & { name: string; isSymlink: boolean }) {
  const [open, setOpen] = useState(false)
  const read = useCallback(async (): Promise<DispatchPreview> => {
    const route = getFileExplorerOperationRoute(owner)
    const relativePath = getRelativePathInsideRoot(path, root)
    if (!route || relativePath === null || isSymlink) {
      return { unavailable: true }
    }
    const file = await readRuntimeFileContent({
      ...route,
      worktreeId,
      filePath: path,
      relativePath,
      wakeWslDistro: true
    })
    return file.isBinary
      ? { unavailable: true }
      : { text: file.content.slice(0, 6000), truncated: file.content.length > 6000 }
  }, [isSymlink, owner, path, root, worktreeId])
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full min-w-0 justify-start gap-1.5 px-1.5 text-xs"
        >
          <FileText className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="truncate" title={name}>
            {name}
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <DispatchWorktreePreview
          path={getRelativePathInsideRoot(path, root) ?? name}
          read={read}
          onClose={() => setOpen(false)}
        />
      </CollapsibleContent>
    </Collapsible>
  )
}

function DirectoryPage({
  after,
  ...directory
}: DirectoryProps & { after?: FileExplorerDirMore['after'] }) {
  const { owner, path, root, worktreeId } = directory
  const t = useTranslate()
  const [showNext, setShowNext] = useState(false)
  const read = useCallback(
    () =>
      readFileExplorerDirectory(worktreeId, root, path, {
        operationOwner: owner,
        followSymlinks: false,
        after,
        wakeWslDistro: true
      }),
    [after, owner, path, root, worktreeId]
  )
  const { result, refresh } = useDispatchSidebarRead(read)
  if (!result?.value) {
    return <DispatchWorktreeReadState error={result?.error} onRetry={refresh} />
  }
  const entries = result.value.entries.filter(shouldIncludeFileExplorerEntry)
  const next = result.value.more?.after
  return (
    <>
      {entries.map((entry) => {
        const child = { ...directory, path: joinPath(path, entry.name) }
        return entry.isDirectory && !entry.isSymlink ? (
          <Collapsible key={entry.name}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="group w-full min-w-0 justify-start gap-1.5 px-1.5 text-xs"
              >
                <ChevronDown
                  className="size-3.5 text-muted-foreground group-data-[state=closed]:-rotate-90 rtl:group-data-[state=closed]:rotate-90"
                  aria-hidden="true"
                />
                <Folder className="size-3.5 text-muted-foreground" aria-hidden="true" />
                <span className="truncate" title={entry.name}>
                  {entry.name}
                </span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="ms-2.5 border-s ps-1.5">
              <DirectoryPage {...child} />
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <FileRow key={entry.name} {...child} name={entry.name} isSymlink={entry.isSymlink} />
        )
      })}
      {next ? (
        showNext ? (
          <DirectoryPage {...directory} after={next} />
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => setShowNext(true)}
          >
            {t('auto.components.rightSidebar.DispatchWorktrees.loadMore', 'Load more')}
          </Button>
        )
      ) : !entries.length && !after ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          {t('auto.components.rightSidebar.DispatchWorktrees.emptyFolder', 'This folder is empty.')}
        </p>
      ) : null}
    </>
  )
}

export function DispatchWorktreeFiles(props: Omit<DirectoryProps, 'path'>): React.JSX.Element {
  return <DirectoryPage {...props} path={props.root} />
}
