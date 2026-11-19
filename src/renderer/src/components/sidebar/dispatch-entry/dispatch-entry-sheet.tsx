import React from 'react'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { useRepoMap } from '@/store/repos/use-repository-catalog'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { STATUS_BAR_RESERVE_HEIGHT, WORKSPACE_TOP_CHROME_HEIGHT } from '../workspace-chrome-metrics'
import { trackSidebarLiveWidth } from '../sidebar-live-width'
import DispatchEntryChat from './dispatch-entry-chat'

// The 统一任务入口 sheet: anchored right of the sidebar over the workbench, the way the
// workspace board drawer is. One sheet at a time — the sidebar closes the board when this opens.

type DispatchEntrySheetProps = {
  hostId: ExecutionHostId
  leftSidebarStyle?: React.CSSProperties
  onClose: () => void
  open: boolean
  repoId: string
  sidebarOpen: boolean
  sidebarWidth: number
  statusBarVisible: boolean
}

export default function DispatchEntrySheet({
  hostId,
  leftSidebarStyle,
  onClose,
  open,
  repoId,
  sidebarOpen,
  sidebarWidth,
  statusBarVisible
}: DispatchEntrySheetProps): React.JSX.Element {
  const repoMap = useRepoMap()
  const repoDisplayName = repoMap.get(repoId)?.displayName ?? repoId
  const drawerLeftCss = sidebarOpen
    ? `var(--workspace-sidebar-live-width, ${sidebarWidth}px)`
    : '0px'
  const drawerBottom = `${statusBarVisible ? STATUS_BAR_RESERVE_HEIGHT : 0}px`
  const keepOpenForOutsideEvent = (event: {
    preventDefault: () => void
    detail: { originalEvent: Event }
  }): void => {
    const originalEvent = event.detail.originalEvent
    const liveDrawerLeft =
      document.querySelector('[data-dispatch-entry-sheet]')?.getBoundingClientRect().left ?? 0
    const pointerX =
      'clientX' in originalEvent && typeof originalEvent.clientX === 'number'
        ? originalEvent.clientX
        : null
    if (pointerX !== null && pointerX < liveDrawerLeft) {
      event.preventDefault()
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose()
        }
      }}
      modal={false}
    >
      <SheetContent
        side="left"
        surface="flush"
        showCloseButton={false}
        ref={trackSidebarLiveWidth}
        overlayStyle={{
          top: WORKSPACE_TOP_CHROME_HEIGHT,
          bottom: drawerBottom,
          left: drawerLeftCss,
          pointerEvents: 'none'
        }}
        style={
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: leftSidebarStyle carries CSS custom properties the CSSProperties type does not model.
          {
            ...leftSidebarStyle,
            left: drawerLeftCss,
            top: WORKSPACE_TOP_CHROME_HEIGHT,
            bottom: drawerBottom,
            height: 'auto',
            width: `min(calc(100vw - ${drawerLeftCss}), 760px)`
          } as React.CSSProperties
        }
        data-dispatch-entry-sheet=""
        onOpenAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={keepOpenForOutsideEvent}
        onInteractOutside={keepOpenForOutsideEvent}
      >
        <DispatchEntryChat
          repoId={repoId}
          hostId={hostId}
          repoDisplayName={repoDisplayName}
          onClose={onClose}
        />
      </SheetContent>
    </Sheet>
  )
}
