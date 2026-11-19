import React from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { MessagesSquare } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'
import { getVirtualRowTransform } from '../viewport/virtual-rows'

// The project's standing 统一任务入口 row (plan §1/§9-A, per-project unique): a door to the
// entry's conversation sheet, which opens through the window event the panel hook listens for.
// Reads as a sidebar list row — same indent and flat hover as the worktree rows under it.

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
      className="flex w-full items-center gap-2 py-1 ps-[22px] pe-3 text-start hover:bg-accent/50"
      onClick={() => openDispatchEntry(repoId, hostId)}
    >
      <MessagesSquare className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {t('auto.components.sidebar.RoutingEntryCard.title', 'Dispatch entry')}
      </span>
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
