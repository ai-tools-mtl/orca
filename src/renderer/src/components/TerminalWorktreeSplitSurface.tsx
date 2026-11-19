import React from 'react'
import type { TabGroupLayoutNode } from '../../../shared/workspace-layout/tab-groups/tab-types'
import type { ActivityTerminalPortalTarget } from './activity/terminal-portal/activity-terminal-portal'
import {
  useBrowserGuestPaintRetention,
  useWorktreeBrowserPageIds
} from './browser-pane/host-guest/retention/browser-guest-paint-retention'
import {
  shouldKeepHiddenWorktreeSurfacePaintable,
  shouldMountRetainedBrowserOverlay
} from './browser-pane/host-guest/retention/browser-worktree-surface-paintability'
import { useDispatchEntryPaneListener } from './sidebar/dispatch-entry/use-dispatch-entry-pane-listener'
import TabGroupSplitLayout from './tab-group/TabGroupSplitLayout'
import { WorkspacePaneOverlayLayers } from './WorkspacePaneOverlayLayers'
import DispatchEntryPaneLayer from './sidebar/dispatch-entry/dispatch-entry-pane-layer'
import type { TerminalPrewarmStage } from './terminal/worktree-prewarm/terminal-worktree-prewarm'

export const WorktreeSplitSurface = React.memo(function WorktreeSplitSurface({
  worktreeId,
  worktreePath,
  layout,
  focusedGroupId,
  isVisible,
  shouldMeasureHiddenWorktree,
  prewarmStage,
  shouldColdParkTerminalPanes,
  isForceParked,
  activityTerminalPortals,
  backgroundMountTabIds,
  activationDeferredMountTabIds
}: {
  worktreeId: string
  worktreePath: string
  layout: TabGroupLayoutNode
  focusedGroupId?: string
  isVisible: boolean
  shouldMeasureHiddenWorktree: boolean
  /** Hover intent: mount, then lay out, then render the revealable terminals while hidden. */
  prewarmStage: TerminalPrewarmStage | null
  shouldColdParkTerminalPanes: boolean
  isForceParked: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  backgroundMountTabIds: ReadonlySet<string> | null
  activationDeferredMountTabIds: ReadonlySet<string> | null
}): React.JSX.Element {
  const browserPageIds = useWorktreeBrowserPageIds(worktreeId)
  const needsBrowserGuestPaint = useBrowserGuestPaintRetention(browserPageIds)
  // The 统一任务入口 fills this surface's pane area while open; only the visible surface answers.
  const dispatchEntry = useDispatchEntryPaneListener(isVisible)
  const shouldKeepPaintable = shouldKeepHiddenWorktreeSurfacePaintable({
    // A mount-stage prewarm stays display:none so its style/layout cost lands in a later task.
    shouldMeasureHiddenWorktree: shouldMeasureHiddenWorktree && prewarmStage !== 'mount',
    needsBrowserGuestPaint
  })

  return (
    <div
      className={
        isVisible
          ? 'absolute inset-0 flex'
          : shouldKeepPaintable
            ? 'absolute inset-0 flex opacity-0 pointer-events-none'
            : 'absolute inset-0 hidden'
      }
      inert={!isVisible}
      aria-hidden={!isVisible}
      data-workspace-surface-id={worktreeId}
    >
      <TabGroupSplitLayout
        layout={layout}
        worktreeId={worktreeId}
        focusedGroupId={focusedGroupId}
        isWorktreeActive={isVisible}
      />
      <WorkspacePaneOverlayLayers
        worktreeId={worktreeId}
        worktreePath={worktreePath}
        isVisible={isVisible}
        shouldMeasureHiddenWorktree={shouldMeasureHiddenWorktree}
        hiddenTerminalPrewarm={prewarmStage === 'mount' ? null : prewarmStage}
        shouldColdParkTerminalPanes={shouldColdParkTerminalPanes}
        isForceParked={isForceParked}
        activityTerminalPortals={activityTerminalPortals}
        backgroundMountTabIds={backgroundMountTabIds}
        activationDeferredMountTabIds={activationDeferredMountTabIds}
        mountRetainedBrowserOverlay={shouldMountRetainedBrowserOverlay({
          isWorktreeVisible: isVisible,
          hasDeferredBackgroundMounts: backgroundMountTabIds !== null,
          needsBrowserGuestPaint
        })}
        mountEmulatorOverlay={isVisible || backgroundMountTabIds === null}
      />
      {dispatchEntry.target ? (
        <DispatchEntryPaneLayer
          hostId={dispatchEntry.target.hostId}
          repoId={dispatchEntry.target.repoId}
          onClose={dispatchEntry.close}
        />
      ) : null}
    </div>
  )
})
