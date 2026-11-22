import { useSidebarResize } from '@/hooks/useSidebarResize'
import { useAppStore } from '@/store'
import { usePluginViewCaptureStore } from '@/store/plugins/capture/plugin-view-capture'
import {
  RIGHT_SIDEBAR_MIN_WIDTH,
  clampRightSidebarPanelWidth,
  computeMaxRightSidebarPanelWidth
} from './right-sidebar-width'
import { useWindowWidth } from './use-window-width'

export function useRightSidebarResize(isOpen: boolean, activityBarSideWidth = 0) {
  const savedWidth = useAppStore((state) => state.rightSidebarWidth)
  const captureWidth = usePluginViewCaptureStore((state) => state.panelWidth)
  const setWidth = useAppStore((state) => state.setRightSidebarWidth)
  const windowWidth = useWindowWidth()
  return useSidebarResize<HTMLDivElement>({
    isOpen,
    width: clampRightSidebarPanelWidth(
      captureWidth ?? savedWidth,
      windowWidth,
      activityBarSideWidth
    ),
    minWidth: RIGHT_SIDEBAR_MIN_WIDTH,
    maxWidth: computeMaxRightSidebarPanelWidth(windowWidth, activityBarSideWidth),
    deltaSign: -1,
    renderedExtraWidth: activityBarSideWidth,
    setWidth
  })
}

export function RightSidebarResizeHandle({
  onResizeStart
}: Pick<ReturnType<typeof useRightSidebarResize>, 'onResizeStart'>): React.JSX.Element {
  return (
    <div
      className="absolute top-0 left-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-ring/20 active:bg-ring/30"
      onMouseDown={onResizeStart}
    />
  )
}
