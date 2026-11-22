import React from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { ChevronRight, MessagesSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'
import { useEntryUnreadIndicator } from '../../dispatch-entry/use-entry-unread-indicator'
import { getVirtualRowTransform } from '../viewport/virtual-rows'
import {
  getWorktreeCardSurfaceInset,
  PROJECT_CHILD_SURFACE_INDENT,
  WORKTREE_CARD_SURFACE_MARGIN
} from './indentation'

export const OPEN_DISPATCH_ENTRY_EVENT = 'orca:open-dispatch-entry'
export const CLOSE_DISPATCH_ENTRY_EVENT = 'orca:close-dispatch-entry'

export function openDispatchEntry(repoId: string, hostId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_DISPATCH_ENTRY_EVENT, { detail: { repoId, hostId } }))
}

// Why: activating a workspace/session from the sidebar must leave the entry even when the
// activation re-selects the already-active workspace, since identity-based auto-close won't fire.
export function closeDispatchEntry(): void {
  window.dispatchEvent(new Event(CLOSE_DISPATCH_ENTRY_EVENT))
}

export default function ProjectRoutingEntryLine({
  repoId,
  hostId
}: {
  repoId: string
  hostId: ExecutionHostId
}): React.JSX.Element {
  const t = useTranslate()
  const unread = useEntryUnreadIndicator(repoId, hostId)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="w-full justify-start gap-2 border-worktree-sidebar-border bg-worktree-sidebar-accent/50 text-start text-[13px] font-semibold text-worktree-sidebar-foreground hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground dark:border-worktree-sidebar-border dark:bg-worktree-sidebar-accent/50 dark:hover:bg-worktree-sidebar-accent"
      onClick={() => openDispatchEntry(repoId, hostId)}
    >
      <MessagesSquare className="size-3.5" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        {t('auto.components.sidebar.RoutingEntryCard.title', 'Project dispatch')}
      </span>
      {unread ? (
        <>
          <span className="size-1.5 shrink-0 rounded-full bg-unread" aria-hidden="true" />
          <span className="sr-only">{t('sidebar.cardSlot.unread', 'Unread result')}</span>
        </>
      ) : null}
      <ChevronRight className="size-3.5 text-muted-foreground rtl:rotate-180" aria-hidden="true" />
    </Button>
  )
}

export function renderProjectRoutingEntryVirtualRow(args: {
  row: Extract<Row, { type: 'project-routing-entry' }>
  vItem: VirtualItem
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
}): React.JSX.Element {
  const surfaceInset = getWorktreeCardSurfaceInset({
    isGrouped: true,
    groupDepth: args.row.groupDepth
  })
  return (
    <div
      role="presentation"
      data-worktree-virtual-row
      data-worktree-virtual-row-key={String(args.vItem.key)}
      data-worktree-virtual-row-start={args.vItem.start}
      data-index={args.vItem.index}
      ref={args.measureVirtualRowElement}
      className="absolute left-0 right-0 top-0 py-1"
      style={{
        transform: getVirtualRowTransform(args.vItem.start),
        paddingInlineStart:
          surfaceInset + PROJECT_CHILD_SURFACE_INDENT + WORKTREE_CARD_SURFACE_MARGIN,
        paddingInlineEnd: WORKTREE_CARD_SURFACE_MARGIN
      }}
    >
      <ProjectRoutingEntryLine repoId={args.row.repoId} hostId={args.row.hostId} />
    </div>
  )
}
