import React from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { useTranslate } from '@/i18n/use-translate'
import { ChevronRight } from 'lucide-react'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'
import { getVirtualRowTransform } from '../viewport/virtual-rows'

// The project's standing 统一任务入口 row (plan §1/§9-A, per-project unique): a door to the
// entry's conversation sheet, which opens through the window event the panel hook listens for.

export const OPEN_DISPATCH_ENTRY_EVENT = 'orca:open-dispatch-entry'

export function openDispatchEntry(repoId: string, hostId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_DISPATCH_ENTRY_EVENT, { detail: { repoId, hostId } }))
}

export default function ProjectRoutingEntryLine({
  repoId,
  hostId
}: {
  repoId: string
  hostId: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <button
      type="button"
      className="mx-2 mb-1.5 flex w-[calc(100%-16px)] items-center gap-2 rounded-md border px-2 py-1.5 text-start transition-colors hover:bg-accent"
      onClick={() => openDispatchEntry(repoId, hostId)}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs font-medium">
          {t('auto.components.sidebar.RoutingEntryCard.title', 'Dispatch entry')}
        </span>
        <span className="text-muted-foreground truncate text-[11px]">
          {t(
            'auto.components.sidebar.RoutingEntryCard.composerPlaceholder',
            'Describe a request for this project'
          )}
        </span>
      </span>
      <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
    </button>
  )
}

export function renderProjectRoutingEntryVirtualRow(args: {
  row: Extract<Row, { type: 'project-routing-entry' }>
  vItem: VirtualItem
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
}): React.JSX.Element {
  return (
    <div
      role="presentation"
      data-worktree-virtual-row
      data-worktree-virtual-row-key={String(args.vItem.key)}
      data-worktree-virtual-row-start={args.vItem.start}
      data-index={args.vItem.index}
      ref={args.measureVirtualRowElement}
      className="absolute left-0 right-0 top-0"
      style={{ transform: getVirtualRowTransform(args.vItem.start) }}
    >
      <ProjectRoutingEntryLine repoId={args.row.repoId} hostId={args.row.hostId} />
    </div>
  )
}
