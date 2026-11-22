import { useRef, useState, type ReactNode } from 'react'
import { Ellipsis, Trash2, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DialogCancel } from '@/components/ui/dialog-parts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { EntryDeleteButton } from './entry-delete-button'
import type { EntryTaskFact } from './entry-task-facts'
import { EntryTaskListMenu } from './entry-task-list-menu'
import { EntryWidthSubmenu } from './entry-width-menu'
import type { NativeChatWidth } from '../../../../../shared/native-chat/settings/native-chat-appearance-settings'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

export type EntryView = 'timeline' | 'board'

export function EntryToolbar({
  repoDisplayName,
  reserveCollapsedSidebarHeaderSpace,
  headerAction,
  view,
  width,
  onViewChange,
  taskFacts,
  onTaskSelect,
  busy,
  automatic,
  savingMode,
  onAutomaticChange,
  onDeleteFailed,
  onClearAll
}: {
  repoDisplayName: string
  reserveCollapsedSidebarHeaderSpace: boolean
  headerAction?: ReactNode
  view: EntryView
  width: NativeChatWidth
  onViewChange: (value: EntryView) => void
  taskFacts: EntryTaskFact[]
  onTaskSelect: (fact: EntryTaskFact) => void
  busy: boolean
  automatic: boolean
  savingMode: boolean
  onAutomaticChange: (checked: boolean) => void
  onDeleteFailed?: () => void
  onClearAll?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [confirmClear, setConfirmClear] = useState(false)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const moreLabel = t(`${ENTRY}.moreActions`, 'More actions')
  const clearLabel = t(`${ENTRY}.clearAll`, 'Clear requests')
  const autoRouteLabel = t(`${ENTRY}.autoRoute`, 'Auto-route')
  return (
    <div
      className="flex min-h-9 flex-none flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border bg-tab-bar px-3.5 py-1"
      style={{
        paddingInlineStart: reserveCollapsedSidebarHeaderSpace
          ? 'calc(var(--collapsed-sidebar-header-width, 0px) + 3.5 * var(--spacing))'
          : undefined,
        paddingInlineEnd: 'calc(var(--window-controls-width, 0px) + 3.5 * var(--spacing))'
      }}
    >
      <div className="flex min-w-0 flex-auto flex-wrap items-center gap-x-4 gap-y-1">
        <div className="flex min-w-0 max-w-64 items-center gap-2 text-sm font-medium">
          <span className="shrink-0">{t(`${ENTRY}.paneTitle`, 'Dispatch')}</span>
          <span aria-hidden="true" className="text-muted-foreground">
            /
          </span>
          <span
            className="truncate text-xs font-normal text-muted-foreground"
            title={repoDisplayName}
          >
            {repoDisplayName}
          </span>
        </div>
        <Tabs
          value={view}
          onValueChange={(value) => onViewChange(value === 'board' ? 'board' : 'timeline')}
          className="shrink-0"
        >
          <TabsList aria-label={t(`${ENTRY}.viewSegmentLabel`, 'Entry views')} size="sm">
            <TabsTrigger value="timeline">{t(`${ENTRY}.viewTimeline`, 'Timeline')}</TabsTrigger>
            <TabsTrigger value="board">{t(`${ENTRY}.viewBoard`, 'Board')}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
        <EntryTaskListMenu facts={taskFacts} onSelect={onTaskSelect} />
        {view === 'timeline' && onDeleteFailed ? (
          <EntryDeleteButton scope="failed" disabled={busy} onDelete={onDeleteFailed} />
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <label className="inline-flex h-7 shrink-0 items-center gap-1.5 px-1 text-muted-foreground">
              <Zap aria-hidden="true" className="size-4" />
              <Switch
                size="compact"
                aria-label={autoRouteLabel}
                checked={automatic}
                disabled={busy || savingMode}
                onCheckedChange={onAutomaticChange}
              />
            </label>
          </TooltipTrigger>
          <TooltipContent side="bottom">{autoRouteLabel}</TooltipContent>
        </Tooltip>
        {view === 'timeline' ? (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    ref={moreButtonRef}
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={moreLabel}
                    className="text-muted-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
                  >
                    <Ellipsis aria-hidden="true" className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{moreLabel}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                if (confirmClear) {
                  event.preventDefault()
                }
              }}
            >
              <EntryWidthSubmenu width={width} />
              {onClearAll ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={busy}
                    onSelect={() => setConfirmClear(true)}
                  >
                    <Trash2 aria-hidden="true" />
                    {clearLabel}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {headerAction}
      </div>
      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent
          size="confirm"
          initialFocus="cancel"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            moreButtonRef.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>{clearLabel}</DialogTitle>
            <DialogDescription>
              {t(
                `${ENTRY}.clearAllDescription`,
                'Delete all eligible requests in this project. Active assignments will be kept.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogCancel variant="ghost" />
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy || !onClearAll}
              onClick={() => {
                setConfirmClear(false)
                onClearAll?.()
              }}
            >
              {clearLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
