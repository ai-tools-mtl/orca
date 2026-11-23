import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { useAppStore } from '@/store/index'
import BrowserPane from '@/components/browser-pane/assemble-chrome/browser-workspace-pane'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import { registerBrowserOverlaySlotViewport } from '@/components/browser-pane/host-guest/viewport/browser-page-viewport'
import { openFileInBrowserTab } from '@/lib/browser/documents/file-preview'
import { openDispatchEntry } from '@/components/sidebar/worktree-list/rows/project-routing-entry-line'

// CDP-driven test probes only; the production bundle never evaluates this branch.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__orcaDevProbe = {
    store: useAppStore,
    React: { createElement },
    createRoot,
    BrowserPane,
    TooltipProvider,
    ConfirmationDialogProvider,
    registerBrowserOverlaySlotViewport,
    openFileInBrowserTab,
    openDispatchEntry
  }
}
