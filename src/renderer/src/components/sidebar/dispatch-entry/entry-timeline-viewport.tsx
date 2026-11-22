import type { ReactNode } from 'react'
import { NativeChatJumpToLatest } from '@/components/native-chat/viewport/scroll/NativeChatJumpToLatest'
import type { useEntryTimeline } from './use-entry-timeline'

export function EntryTimelineViewport({
  scroll,
  children
}: {
  scroll: ReturnType<typeof useEntryTimeline>['scroll']
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroll.streamRef}
        onScroll={scroll.onScroll}
        data-dispatch-entry-stream=""
        className="h-full overflow-y-auto scrollbar-sleek [scrollbar-gutter:stable_both-edges]"
      >
        {children}
      </div>
      <div className="absolute inset-x-0 bottom-0 z-30">
        <NativeChatJumpToLatest visible={scroll.showJump} onJump={scroll.jumpToLatest} />
      </div>
    </div>
  )
}
