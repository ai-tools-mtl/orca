import React, { useEffect, useMemo, useRef, useState } from 'react'
import { PanelRight } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { cn } from '@/lib/class-names'
import { RightSidebarToggle } from '@/app-shell/chrome/TitlebarMainStrip'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { getTopActivityBarLayout } from './activity-bar/activity-bar-overflow'
import { ActivityBarButton } from './activity-bar/activity-bar-buttons'
import { getActiveChecksStatus } from './checks-panel/status/active-checks-status'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { RIGHT_SIDEBAR_SIDE_ACTIVITY_BAR_WIDTH as ACTIVITY_BAR_SIDE_WIDTH } from './layout/right-sidebar-width'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { RightSidebarPanelContent } from './right-sidebar-panel-content'
import { useMeasuredWidth } from './layout/right-sidebar-measured-width'
import {
  isPairedWebClientWindow,
  shouldRenderDesktopWindowChrome
} from '@/app-shell/chrome/desktop-window-chrome'
import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'
import {
  ActivityBarPositionMenu,
  useActivityBarContextPlugin
} from './activity-bar/activity-bar-position-menu'
import { RightSidebarTopActivityBar } from './activity-bar/right-sidebar-top-activity-bar'
import { useRightSidebarActivityItems } from './activity-bar/use-right-sidebar-activity-items'
import { useRightSidebarTabRouting } from './activity-bar/use-right-sidebar-tab-routing'
import { RightSidebarResizeHandle, useRightSidebarResize } from './layout/right-sidebar-resize'
import { selectWorktreeCreationSurfaceShown } from '@/lib/workspace/creation/worktree-creation-surface'

function WorkspaceRightSidebar(): React.JSX.Element {
  const t = useTranslate()
  const contextPlugin = useActivityBarContextPlugin()
  useUiLanguageRevision()
  const hasDesktopWindowChrome = shouldRenderDesktopWindowChrome({
    platform: getRendererAppPlatform(),
    isWebClient: isPairedWebClientWindow()
  })
  const rightSidebarShortcut = useShortcutLabel('sidebar.right.toggle')
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const routeRequestId = useAppStore((s) => s.rightSidebarRouteRequestId)
  const settingsFocusRequested = useAppStore((s) => s.aiVaultSearchFocusRequested)
  const lastRouteRequestId = useRef(routeRequestId)
  const [focusVaultSearch, setFocusVaultSearch] = useState(false)
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar)
  // Creation keeps the prior worktree active until handoff, so its panels would show that worktree.
  const creatingWorktree = useAppStore(selectWorktreeCreationSurfaceShown)
  const checksStatus = useAppStore((s) =>
    s.rightSidebarOpen && !creatingWorktree ? getActiveChecksStatus(s) : null
  )
  const activityBarPosition = useAppStore((s) => s.activityBarPosition)
  const setActivityBarPosition = useAppStore((s) => s.setActivityBarPosition)
  const [topActivityStripWidth, setTopActivityStripWidth] = useState<number | null>(null)
  const {
    visibleItems,
    activeFolderWorkspaceKey,
    pluginSystemEnabled,
    pluginFetchStatus,
    installedPluginTabKeys
  } = useRightSidebarActivityItems({ rightSidebarOpen })
  const { effectiveTab, selectActivityTab } = useRightSidebarTabRouting({
    visibleItems,
    activeFolderWorkspaceKey,
    pluginSystemEnabled,
    pluginFetchStatus,
    installedPluginTabKeys
  })

  useEffect(() => {
    if (lastRouteRequestId.current === routeRequestId) {
      if (!rightSidebarOpen || creatingWorktree || effectiveTab !== 'vault') {
        setFocusVaultSearch(false)
      }
      return
    }
    lastRouteRequestId.current = routeRequestId
    setFocusVaultSearch(
      rightSidebarOpen &&
        !creatingWorktree &&
        rightSidebarTab === 'vault' &&
        effectiveTab === 'vault' &&
        !settingsFocusRequested
    )
  }, [
    routeRequestId,
    rightSidebarOpen,
    rightSidebarTab,
    effectiveTab,
    creatingWorktree,
    settingsFocusRequested
  ])

  useEffect(() => {
    if (!focusVaultSearch) {
      return
    }
    const cancel = (): void => setFocusVaultSearch(false)
    document.addEventListener('pointerdown', cancel, true)
    document.addEventListener('keydown', cancel, true)
    return () => {
      document.removeEventListener('pointerdown', cancel, true)
      document.removeEventListener('keydown', cancel, true)
    }
  }, [focusVaultSearch])

  const activityBarSideWidth = activityBarPosition === 'side' ? ACTIVITY_BAR_SIDE_WIDTH : 0
  const { containerRef, onResizeStart } = useRightSidebarResize(
    rightSidebarOpen,
    activityBarSideWidth
  )
  const topActivityStripRef = useMeasuredWidth(setTopActivityStripWidth)

  const panelContent = rightSidebarOpen ? (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden scrollbar-sleek-parent">
      {creatingWorktree ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
          {t(
            'auto.components.right.sidebar.index.creatingWorkspace',
            'Available when the workspace is ready'
          )}
        </div>
      ) : (
        // Keep panels mounted across worktree switches; remounts caused Windows IPC storms and multi-second freezes.
        <RightSidebarPanelContent
          effectiveTab={effectiveTab}
          rightSidebarOpen={rightSidebarOpen}
          focusVaultSearch={focusVaultSearch}
          onVaultSearchFocusHandled={() => setFocusVaultSearch(false)}
        />
      )}
    </div>
  ) : null

  const topActivityLayout = useMemo(
    () => getTopActivityBarLayout(visibleItems, topActivityStripWidth, effectiveTab),
    [visibleItems, topActivityStripWidth, effectiveTab]
  )

  const sideActivityBarIcons = visibleItems.map((item) => (
    <ActivityBarButton
      key={item.id}
      item={item}
      active={effectiveTab === item.id}
      onClick={() => selectActivityTab(item.id)}
      layout="side"
      statusIndicator={item.id === 'checks' ? checksStatus : null}
    />
  ))

  const closeButton = rightSidebarOpen ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="sidebar-toggle mr-1"
          onClick={toggleRightSidebar}
          aria-label={t('auto.components.right.sidebar.index.e8e2e4ce74', 'Toggle right sidebar')}
        >
          <PanelRight size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {t('auto.components.right.sidebar.index.9fffaf17c1', 'Toggle right sidebar ({{value0}})', {
          value0: rightSidebarShortcut
        })}
      </TooltipContent>
    </Tooltip>
  ) : null

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex-shrink-0 flex flex-row',
        // Allow the open resize handle to overflow; at width zero, clip mounted content and icons.
        rightSidebarOpen ? 'overflow-visible' : 'overflow-hidden'
      )}
    >
      <div
        className="flex flex-col flex-1 min-w-0 bg-sidebar overflow-hidden"
        style={{
          borderLeft: rightSidebarOpen ? '1px solid var(--sidebar-border)' : 'none'
        }}
      >
        {activityBarPosition === 'top' ? (
          <RightSidebarTopActivityBar
            hasDesktopWindowChrome={hasDesktopWindowChrome}
            topActivityStripRef={topActivityStripRef}
            topActivityLayout={topActivityLayout}
            effectiveTab={effectiveTab}
            onSelectTab={selectActivityTab}
            checksStatus={checksStatus}
            closeButton={closeButton}
            activityBarPosition={activityBarPosition}
            onChangeActivityBarPosition={setActivityBarPosition}
          />
        ) : (
          /* The 40px activity bar absorbs part of the 138px window-control overlay; inset the header by the remaining 98px. */
          <div className="flex items-center justify-between h-[36px] min-h-[36px] px-3 border-b border-border right-sidebar-header-side-inset right-sidebar-header-drag">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
              {visibleItems.find((item) => item.id === effectiveTab)?.title ?? ''}
            </span>
            <TooltipProvider>
              <div className="flex items-center">{closeButton}</div>
            </TooltipProvider>
          </div>
        )}

        {panelContent}

        <RightSidebarResizeHandle onResizeStart={onResizeStart} />
      </div>

      {activityBarPosition === 'side' && (
        <ContextMenu>
          <ContextMenuTrigger
            asChild
            onContextMenu={contextPlugin.onContextMenu}
            onPointerDown={contextPlugin.onPointerDown}
          >
            <div className="flex flex-col items-center w-10 min-w-[40px] bg-sidebar border-l border-border side-activity-bar-windows-inset">
              <TooltipProvider>{sideActivityBarIcons}</TooltipProvider>
            </div>
          </ContextMenuTrigger>
          <ActivityBarPositionMenu
            currentPosition={activityBarPosition}
            onChangePosition={setActivityBarPosition}
            pluginKey={contextPlugin.pluginKey}
          />
        </ContextMenu>
      )}
    </div>
  )
}

function DispatchRightSidebar({
  viewportRef
}: {
  viewportRef: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  const open = useAppStore((state) => state.rightSidebarOpen)
  const { containerRef, onResizeStart } = useRightSidebarResize(open)
  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex shrink-0 flex-col bg-sidebar',
        open ? 'border-s border-sidebar-border' : 'overflow-hidden'
      )}
    >
      {open ? (
        <>
          <div className="right-sidebar-header-inset right-sidebar-header-drag flex h-9 min-h-9 justify-end border-b border-border">
            <RightSidebarToggle />
          </div>
          <div ref={viewportRef} className="flex min-h-0 flex-1 flex-col overflow-hidden" />
          <RightSidebarResizeHandle onResizeStart={onResizeStart} />
        </>
      ) : null}
    </div>
  )
}

const RightSidebar = React.memo(function RightSidebar({
  dispatchViewportRef
}: {
  dispatchViewportRef?: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  return dispatchViewportRef ? (
    <DispatchRightSidebar viewportRef={dispatchViewportRef} />
  ) : (
    <WorkspaceRightSidebar />
  )
})
export default RightSidebar
