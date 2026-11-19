import React from 'react'
import { useRepoMap } from '@/store/repos/use-repository-catalog'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import DispatchEntryChat from './dispatch-entry-chat'

// The 统一任务入口 living in the workbench pane area (the region agent chats render in):
// an in-surface layer that fills it while open — no new session kind, the panes sit under it.

export default function DispatchEntryPaneLayer({
  hostId,
  repoId
}: {
  hostId: ExecutionHostId
  repoId: string
}): React.JSX.Element {
  const repoMap = useRepoMap()
  const repoDisplayName = repoMap.get(repoId)?.displayName ?? repoId
  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-chat-pane">
      <DispatchEntryChat repoId={repoId} hostId={hostId} repoDisplayName={repoDisplayName} />
    </div>
  )
}
