import { Suspense } from 'react'
import { createPortal } from 'react-dom'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { RecoverableRenderErrorBoundary } from '@/components/error-boundaries/RecoverableRenderErrorBoundary'

const DispatchWorktreesPanel = lazy(() => import('./dispatch-worktrees-panel'))

export function DispatchWorktreesPortal({
  viewport,
  ...props
}: React.ComponentProps<typeof DispatchWorktreesPanel> & {
  viewport?: HTMLDivElement | null
}): React.JSX.Element | null {
  // The timeline owns the project snapshot, including when the right sidebar is closed.
  return viewport
    ? createPortal(
        <RecoverableRenderErrorBoundary
          boundaryId="dispatch-project-worktrees"
          surface="right-sidebar"
          resetKey={JSON.stringify([props.hostId, props.repoId])}
          compact
        >
          <Suspense fallback={null}>
            <DispatchWorktreesPanel {...props} />
          </Suspense>
        </RecoverableRenderErrorBoundary>,
        viewport
      )
    : null
}
