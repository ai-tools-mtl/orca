import { useMemo, useState } from 'react'
import { ChevronDown, Folder, GitBranch, ListTodo } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import { findRepoForHost } from '@/store/repos/repo-host-identity'
import {
  worktreeHostMatchOptions,
  worktreeMatchesHost
} from '@/store/slices/worktrees/listing/worktree-host-ownership'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { isFolderRepo } from '../../../../../shared/repository/repo-kind'
import { composeWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { useRoutingEntryFacts } from '../../sidebar/workspace-card/activity/use-routing-entry-facts'
import type { RoutingEntrySubAction } from '../../sidebar/workspace-card/activity/routing-entry-model'
import {
  entryTaskPresentation,
  entryTimelineTaskStatus
} from '../../sidebar/dispatch-entry/entry-timeline-status'
import { EntryTimelineStatusBadge } from '../../sidebar/dispatch-entry/entry-timeline-status-badge'
import {
  getFileExplorerOperationOwnerFromState,
  getFileExplorerOperationRoute
} from '../file-explorer/navigation/file-explorer-operation-owner'
import { DispatchWorktreeChanges } from './dispatch-worktree-changes'
import { DispatchWorktreeFiles } from './dispatch-worktree-files'
import { DispatchWorktreeReadState } from './dispatch-worktree-read-state'

type DispatchFacts = Pick<
  ReturnType<typeof useRoutingEntryFacts>,
  'inputs' | 'hasSnapshot' | 'approvals' | 'error' | 'refresh'
>
type Task = { action: RoutingEntrySubAction; awaitingApproval: boolean }

export default function DispatchWorktreesPanel({
  repoId,
  hostId,
  facts,
  onSelectTask
}: {
  repoId: string
  hostId: ExecutionHostId
  facts: DispatchFacts
  onSelectTask: (subActionId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const repo = useAppStore((state) => findRepoForHost(state.repos, repoId, { hostId }))
  const tracked = useAppStore((state) => selectWorktreesByRepo(state)[repoId])
  const detected = useAppStore((state) => selectDetectedWorktreesByRepo(state)[repoId]?.worktrees)
  const { unhostedWorktreesMatchHost } = useAppStore(
    useShallow((state) => worktreeHostMatchOptions(state, repoId, hostId))
  )
  const worktrees = useMemo(() => {
    const rows = new Map<string, Worktree>()
    for (const row of [...(tracked ?? []), ...(detected ?? [])]) {
      if (
        row.repoId !== repoId ||
        !worktreeMatchesHost(row, hostId, { unhostedWorktreesMatchHost })
      ) {
        continue
      }
      const identity = composeWorktreeHostIdentity(row.hostId ?? hostId, row.id)
      if (!rows.has(identity)) {
        rows.set(identity, row)
      }
    }
    return [...rows.entries()].sort(
      ([, a], [, b]) => Number(b.isMainWorktree) - Number(a.isMainWorktree)
    )
  }, [detected, hostId, repoId, tracked, unhostedWorktreesMatchHost])
  const tasksByWorktree = useMemo(() => {
    const index = new Map<string, Task[]>()
    const approvals = new Set(facts.approvals.map((approval) => approval.dispatchId))
    for (const { subActions } of facts.inputs) {
      for (const action of subActions) {
        const execution = action.execution
        if (action.resumed || !execution?.worktreeId) {
          continue
        }
        const items = index.get(execution.worktreeId) ?? []
        items.push({ action, awaitingApproval: approvals.has(execution.dispatchId) })
        index.set(execution.worktreeId, items)
      }
    }
    return index
  }, [facts.approvals, facts.inputs])
  const worktreeIdCounts = new Map<string, number>()
  for (const [, worktree] of worktrees) {
    worktreeIdCounts.set(worktree.id, (worktreeIdCounts.get(worktree.id) ?? 0) + 1)
  }
  const folder = repo ? isFolderRepo(repo) : false

  return (
    <aside
      aria-label={t('auto.components.rightSidebar.DispatchWorktrees.title', 'Project worktrees')}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="space-y-1 border-b border-sidebar-border px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <h2 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
            <GitBranch className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {t('auto.components.rightSidebar.DispatchWorktrees.title', 'Project worktrees')}
          </h2>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {t(
              'auto.components.rightSidebar.DispatchWorktrees.worktreeCount',
              '{{count}} worktrees',
              {
                count: worktrees.length,
                defaultValue_one: '{{count}} worktree'
              }
            )}
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground" title={repo?.displayName ?? repoId}>
          {repo?.displayName ?? repoId}
        </p>
      </div>
      <div className="scrollbar-sleek min-h-0 flex-1 divide-y divide-sidebar-border overflow-y-auto">
        {worktrees.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {t(
              'auto.components.rightSidebar.DispatchWorktrees.emptyWorktrees',
              'No worktrees for this project.'
            )}
          </p>
        ) : (
          worktrees.map(([identity, worktree]) => (
            <WorktreeGroup
              key={JSON.stringify([identity, worktree.instanceId, worktree.path])}
              worktree={worktree}
              hostId={hostId}
              folder={folder}
              ambiguous={(worktreeIdCounts.get(worktree.id) ?? 0) > 1}
              tasks={tasksByWorktree.get(worktree.id) ?? []}
              tasksError={facts.error}
              tasksLoading={!facts.hasSnapshot}
              refreshTasks={() => void facts.refresh()}
              onSelectTask={onSelectTask}
            />
          ))
        )}
      </div>
    </aside>
  )
}

function WorktreeGroup({
  worktree,
  hostId,
  folder,
  ambiguous,
  tasks,
  tasksError,
  tasksLoading,
  refreshTasks,
  onSelectTask
}: {
  worktree: Worktree
  hostId: ExecutionHostId
  folder: boolean
  ambiguous: boolean
  tasks: Task[]
  tasksError: string | null
  tasksLoading: boolean
  refreshTasks: () => void
  onSelectTask: (subActionId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [tab, setTab] = useState('files')
  const running = ambiguous
    ? 0
    : tasks.filter(
        ({ action, awaitingApproval }) =>
          entryTimelineTaskStatus(action, awaitingApproval) === 'running'
      ).length
  const subtitle = folder
    ? t('auto.components.rightSidebar.DispatchWorktrees.folder', 'Folder')
    : worktree.branch?.replace(/^refs\/heads\//, '') ||
      t('auto.components.rightSidebar.DispatchWorktrees.detached', 'Detached HEAD')
  const Icon = folder ? Folder : GitBranch
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="group h-auto min-h-11 w-full justify-start gap-1.5 rounded-none px-2.5 py-1.5 text-start"
        >
          <ChevronDown
            className="size-3.5 text-muted-foreground group-data-[state=closed]:-rotate-90 rtl:group-data-[state=closed]:rotate-90"
            aria-hidden="true"
          />
          <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="grid min-w-0 flex-1">
            <span className="truncate text-sm font-medium" title={worktree.displayName}>
              {worktree.displayName}
            </span>
            {subtitle !== worktree.displayName ? (
              <span className="truncate text-xs font-normal text-muted-foreground" title={subtitle}>
                {subtitle}
              </span>
            ) : null}
          </span>
          {worktree.isMainWorktree && !folder ? (
            <span className="rounded-full bg-muted px-1.5 text-2xs font-normal text-muted-foreground">
              {t('auto.components.rightSidebar.DispatchWorktrees.main', 'Main')}
            </span>
          ) : null}
          {running > 0 ? <EntryTimelineStatusBadge status="running" count={running} /> : null}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2.5 pb-2.5">
        {ambiguous ? (
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.rightSidebar.DispatchWorktrees.ambiguousWorktree',
              'This worktree could not be uniquely identified.'
            )}
          </p>
        ) : (
          <Tabs
            value={tab}
            onValueChange={setTab}
            activationMode="manual"
            className="min-w-0 gap-1"
          >
            <TabsList size="sm" aria-label={worktree.displayName} className="w-full">
              <TabsTrigger value="files" className="min-w-0 px-1">
                {t('auto.components.rightSidebar.DispatchWorktrees.files', 'Files')}
              </TabsTrigger>
              <TabsTrigger value="changes" className="min-w-0 px-1">
                {t('auto.components.rightSidebar.DispatchWorktrees.changes', 'Changes')}
              </TabsTrigger>
              <TabsTrigger value="tasks" className="min-w-0 px-1">
                {t('auto.components.rightSidebar.DispatchWorktrees.tasks', 'Tasks')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="files">
              <WorktreeFilesOrChanges
                worktree={worktree}
                hostId={hostId}
                folder={folder}
                view="files"
              />
            </TabsContent>
            <TabsContent value="changes">
              <WorktreeFilesOrChanges
                worktree={worktree}
                hostId={hostId}
                folder={folder}
                view="changes"
              />
            </TabsContent>
            <TabsContent value="tasks">
              {tasksError || tasksLoading ? (
                <DispatchWorktreeReadState error={tasksError ?? undefined} onRetry={refreshTasks} />
              ) : null}
              {tasks.map(({ action, awaitingApproval }) => {
                const { activity, sender, status, tone } = entryTaskPresentation(
                  action,
                  awaitingApproval,
                  t
                )
                return (
                  <Button
                    key={action.subActionId}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto min-h-8 w-full min-w-0 justify-start gap-1.5 px-1.5 py-1 text-start text-xs"
                    onClick={() => onSelectTask(action.subActionId)}
                  >
                    <ListTodo className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="truncate" title={action.text}>
                        {action.text}
                      </span>
                      {sender ? (
                        <span className="truncate font-normal text-muted-foreground">{sender}</span>
                      ) : null}
                    </span>
                    {activity ? (
                      <EntryTimelineStatusBadge status={activity} label={status} />
                    ) : (
                      <span
                        className={cn(
                          'text-2xs font-normal',
                          {
                            neutral: 'text-muted-foreground',
                            warning: 'text-status-warning-text',
                            success: 'text-status-success',
                            error: 'text-destructive'
                          }[tone]
                        )}
                      >
                        {status}
                      </span>
                    )}
                  </Button>
                )
              })}
              {!tasks.length && !tasksError && !tasksLoading ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t(
                    'auto.components.rightSidebar.DispatchWorktrees.emptyTasks',
                    'No dispatch tasks linked to this worktree.'
                  )}
                </p>
              ) : null}
            </TabsContent>
          </Tabs>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function WorktreeFilesOrChanges({
  worktree,
  hostId,
  folder,
  view
}: {
  worktree: Worktree
  hostId: ExecutionHostId
  folder: boolean
  view: 'files' | 'changes'
}): React.JSX.Element {
  const { id, path } = worktree
  const owner = useAppStore(
    useShallow((state) => getFileExplorerOperationOwnerFromState(state, id, hostId))
  )
  const context = useMemo(() => {
    const route = getFileExplorerOperationRoute(owner)
    return route ? { ...route, worktreeId: id, worktreePath: path } : null
  }, [id, owner, path])
  return view === 'files' ? (
    <DispatchWorktreeFiles worktreeId={id} root={path} owner={owner} />
  ) : (
    <DispatchWorktreeChanges context={context} folder={folder} />
  )
}
