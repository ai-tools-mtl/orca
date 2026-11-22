import type { ReactNode } from 'react'
import { useAppStore } from '@/store'
import { findRepoForHost } from '@/store/repos/repo-host-identity'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { RecoverableRenderErrorBoundary } from '../../error-boundaries/RecoverableRenderErrorBoundary'
import DispatchEntryChat from './dispatch-entry-chat'

export default function DispatchEntryPane({
  hostId,
  repoId,
  sidebarViewport,
  onWorkspaceOpened,
  reserveCollapsedSidebarHeaderSpace,
  headerAction
}: {
  hostId: ExecutionHostId
  repoId: string
  sidebarViewport?: HTMLDivElement | null
  onWorkspaceOpened: () => void
  reserveCollapsedSidebarHeaderSpace: boolean
  headerAction?: ReactNode
}): React.JSX.Element {
  const repoDisplayName = useAppStore(
    (state) => findRepoForHost(state.repos, repoId, { hostId })?.displayName ?? repoId
  )
  return (
    <div className="isolate flex min-h-0 min-w-0 flex-1 flex-col">
      <RecoverableRenderErrorBoundary
        boundaryId="dispatch-entry-pane"
        surface="dispatch-entry-pane"
        resetKey={JSON.stringify([hostId, repoId])}
        compact
      >
        <DispatchEntryChat
          key={JSON.stringify([hostId, repoId])}
          repoId={repoId}
          hostId={hostId}
          sidebarViewport={sidebarViewport}
          repoDisplayName={repoDisplayName}
          onWorkspaceOpened={onWorkspaceOpened}
          reserveCollapsedSidebarHeaderSpace={reserveCollapsedSidebarHeaderSpace}
          headerAction={headerAction}
        />
      </RecoverableRenderErrorBoundary>
    </div>
  )
}
