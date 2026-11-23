import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Eye, X } from 'lucide-react'
import BrowserPane from '@/components/browser-pane/assemble-chrome/browser-workspace-pane'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import {
  getBrowserOverlaySlotViewport,
  registerBrowserOverlaySlotViewport
} from '@/components/browser-pane/host-guest/viewport/browser-page-viewport'
import { useBrowserPageSlotViewport } from '@/components/browser-pane/host-guest/viewport/use-browser-page-slot-viewport'
import { absolutePathToFileUri } from '@/components/editor/markdown/link-routing/markdown-internal-links'
import { useTranslate } from '@/i18n/use-translate'
import { basename } from '@/lib/path'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { BrowserWorkspace } from '../../../../../shared/browser/workspaces/browser-workspace-types'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

// Hidden worktree surfaces keep their overlay slots mounted, so each preview slot borrows the
// registration and restores the previous root instead of clearing it. Guests persist per slot,
// so switching strip chips only flips display like the workspace overlay does.
function PreviewSlotViewport({
  tabId,
  hidden
}: {
  tabId: string
  hidden: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const restoredRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) {
      return
    }
    restoredRef.current = getBrowserOverlaySlotViewport(tabId)
    registerBrowserOverlaySlotViewport(tabId, node)
    return () => registerBrowserOverlaySlotViewport(tabId, restoredRef.current)
  }, [tabId])
  const slotViewport = useBrowserPageSlotViewport(tabId)
  useEffect(() => {
    const node = ref.current
    if (node?.isConnected && slotViewport !== node) {
      registerBrowserOverlaySlotViewport(tabId, node)
    }
  }, [slotViewport, tabId])
  return (
    <div
      ref={ref}
      className="absolute inset-0 flex min-h-0 flex-col"
      style={hidden ? { display: 'none' } : undefined}
    />
  )
}

function selectPreviewBrowserTabId(
  state: AppState,
  worktreeId: string,
  filePath: string
): string | null {
  const tabs = state.browserTabsByWorktree[worktreeId] ?? []
  const pagesOf = (tabId: string) => state.browserPagesByWorkspace[tabId] ?? []
  const withPages = tabs.filter((tab) => pagesOf(tab.id).length > 0)
  if (withPages.length === 0) {
    return null
  }
  const fileUri = absolutePathToFileUri(filePath)
  const showingFile = withPages.find((tab) =>
    pagesOf(tab.id).some((page) => page.docLocation?.filePath === filePath || page.url === fileUri)
  )
  return (showingFile ?? withPages.at(-1)!).id
}

function previewTabTitle(state: AppState, tab: BrowserWorkspace): string {
  const pages = state.browserPagesByWorkspace[tab.id] ?? []
  const active = pages.find((page) => page.id === tab.activePageId) ?? pages.at(-1)
  return active?.title || basename(active?.url ?? '') || tab.id.slice(0, 8)
}

// Tab ids and titles ride one primitive string so unrelated store writes never rerender the strip.
const PREVIEW_TAB_FIELD = '␟'
const PREVIEW_TAB_ROW = '␞'

function previewTabRows(state: AppState, worktreeId: string): string {
  return (state.browserTabsByWorktree[worktreeId] ?? [])
    .filter((tab) => (state.browserPagesByWorkspace[tab.id] ?? []).length > 0)
    .map((tab) => `${tab.id}${PREVIEW_TAB_FIELD}${previewTabTitle(state, tab)}`)
    .join(PREVIEW_TAB_ROW)
}

export function EntryWorktreePreview({
  worktreeId,
  filePath,
  onClose
}: {
  worktreeId: string
  filePath: string
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const matchedTabId = useAppStore((state) =>
    selectPreviewBrowserTabId(state, worktreeId, filePath)
  )
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null)
  const tabRows = useAppStore((state) => previewTabRows(state, worktreeId))
  const previewTabs = useMemo(
    () =>
      tabRows.split(PREVIEW_TAB_ROW).map((row) => {
        const fieldIndex = row.indexOf(PREVIEW_TAB_FIELD)
        return { id: row.slice(0, fieldIndex), title: row.slice(fieldIndex + 1) }
      }),
    [tabRows]
  )
  const wsTabId =
    selectedTabId && previewTabs.some((tab) => tab.id === selectedTabId)
      ? selectedTabId
      : matchedTabId
  const wsTab = useAppStore((state) =>
    wsTabId
      ? ((state.browserTabsByWorktree[worktreeId] ?? []).find((tab) => tab.id === wsTabId) ?? null)
      : null
  )
  // Chips hand-roll the Tabs look because each needs its own close button (no nested buttons).
  const closePreviewTab = useCallback(
    (tabId: string) => {
      useAppStore.getState().closeBrowserTab(tabId)
      if (selectedTabId === tabId) {
        setSelectedTabId(null)
      }
      const state = useAppStore.getState()
      const remaining = (state.browserTabsByWorktree[worktreeId] ?? []).some(
        (tab) => (state.browserPagesByWorkspace[tab.id] ?? []).length > 0
      )
      if (!remaining) {
        onClose()
      }
    },
    [onClose, selectedTabId, worktreeId]
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-entry-worktree-preview={wsTabId ?? ''}>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b px-1.5">
        {previewTabs.length > 0 ? (
          <div
            aria-label={t(`${ENTRY}.previewTabList`, 'Preview tabs')}
            className="scrollbar-sleek flex min-w-0 flex-1 items-center gap-1 overflow-x-auto rounded-lg bg-muted p-[3px]"
            role="tablist"
          >
            {previewTabs.map((tab) => {
              const selected = tab.id === wsTabId
              return (
                <div
                  key={tab.id}
                  className={cn(
                    'group/chip flex h-6 min-w-0 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-xs',
                    selected
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 max-w-32 cursor-pointer truncate"
                    title={tab.title}
                    onClick={() => setSelectedTabId(tab.id)}
                  >
                    {tab.title}
                  </button>
                  <button
                    type="button"
                    className="cursor-pointer rounded-sm p-0.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                    aria-label={t(`${ENTRY}.previewTabClose`, 'Close tab')}
                    onClick={() => closePreviewTab(tab.id)}
                  >
                    <X aria-hidden="true" className="size-3" />
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          <span className="flex-1" />
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label={t(
            'auto.components.rightSidebar.DispatchWorktrees.closePreview',
            'Close preview'
          )}
          onClick={onClose}
        >
          <X aria-hidden="true" className="size-3.5" />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {previewTabs.map((tab) => (
          <PreviewSlotViewport key={tab.id} tabId={tab.id} hidden={tab.id !== wsTabId} />
        ))}
        {wsTab ? (
          <BrowserPane browserTab={wsTab} isActive chromeShortcutScope="inactive" />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
            <Eye aria-hidden="true" className="size-5" />
            <p className="max-w-sm text-xs leading-relaxed">
              {t(
                `${ENTRY}.previewEmpty`,
                'Open a file from the worktree files to preview it here.'
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
