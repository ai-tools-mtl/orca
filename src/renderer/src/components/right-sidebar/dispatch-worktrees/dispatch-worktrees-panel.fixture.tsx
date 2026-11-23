import { useEffect } from 'react'
import { AppWorkspaceShell } from '@/app-shell/AppWorkspaceShell'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import { useAppChromeLayout } from '@/app-shell/chrome/use-app-chrome-layout'
import { useAppStore } from '@/store'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useFloatingWorkspacePanel } from '../../floating-terminal/workspace/use-floating-workspace-panel'
import { useDispatchEntryPaneListener } from '../../sidebar/dispatch-entry/use-dispatch-entry-pane-listener'
import { openDispatchEntry } from '../../sidebar/worktree-list/rows/project-routing-entry-line'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { DirEntry } from '../../../../../shared/file-listing/directory-entry'

const project = {
  id: 'inventory',
  path: '/checkout/inventory',
  displayName: 'Inventory',
  badgeColor: 'blue',
  addedAt: 1
} satisfies Repo
const other = {
  id: 'website',
  path: '/checkout/website',
  displayName: 'Website',
  badgeColor: 'green',
  addedAt: 2
} satisfies Repo

function worktree(repo: Repo, path: string, displayName: string, branch: string): Worktree {
  return {
    id: `${repo.id}::${path}`,
    repoId: repo.id,
    hostId: 'local',
    path,
    displayName,
    head: 'abc',
    branch: `refs/heads/${branch}`,
    isBare: false,
    isMainWorktree: repo.path === path,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

const main = worktree(project, project.path, 'main', 'main')
const docs = worktree(project, '/checkout/inventory-docs', 'Docs requirements spec', 'docs/spec')
const hidden = worktree(project, '/checkout/inventory-external', 'External checkout', 'external')
const website = worktree(other, other.path, 'Website checkout', 'main')
const foreign = {
  ...docs,
  displayName: 'Other host checkout',
  hostId: 'runtime:other-host'
} satisfies Worktree

function dirEntry(name: string, isDirectory = false): DirEntry {
  return { name, isDirectory, isSymlink: false }
}

const directoryEntries: Record<string, DirEntry[]> = {
  [main.path]: [dirEntry('main-only.md'), dirEntry('README.md')],
  [docs.path]: [dirEntry('prototype', true), dirEntry('docs-only.md'), dirEntry('README.md')],
  [`${docs.path}/prototype`]: [dirEntry('index.html')],
  [website.path]: [dirEntry('website-only.md')]
}

function setup(): void {
  window.api.fs.readDir = async ({ dirPath }) => directoryEntries[dirPath] ?? []
  window.api.fs.readFile = async ({ filePath }) => ({
    content: `Read from ${filePath}`,
    isBinary: false
  })
  window.api.git.status = async ({ worktreePath }) => ({
    conflictOperation: 'unknown',
    entries:
      worktreePath === docs.path
        ? [{ path: 'docs-only.md', status: 'modified', area: 'unstaged' }]
        : []
  })
  window.api.git.diff = async ({ worktreePath }) => ({
    kind: 'text',
    originalContent: 'Before\n',
    modifiedContent: `Changes in ${worktreePath}\n`,
    originalIsBinary: false,
    modifiedIsBinary: false
  })
  const original = window.api.runtime.call
  window.api.runtime.call = async (request) => {
    const respond = (result: object) => ({
      id: 'fixture',
      ok: true as const,
      _meta: { runtimeId: 'fixture' },
      result
    })
    switch (request.method) {
      case 'orchestration.entryShow': {
        const params = request.params
        const currentProject =
          typeof params === 'object' &&
          params !== null &&
          'group' in params &&
          params.group === project.id
        return respond({
          watchdog: { paused: false },
          inputs: currentProject
            ? [
                {
                  input: {
                    input_id: 'inventory-request',
                    received_seq: 1,
                    decision_status: 'decided',
                    created_at: new Date().toISOString(),
                    raw_text: 'Build a small inventory tool'
                  },
                  subActions: [
                    {
                      subAction: {
                        sub_action_id: 'write-requirements',
                        text: 'Write inventory requirements',
                        task_id: null,
                        state: 'delivered',
                        claimed_dispatch_id: null
                      },
                      execution: {
                        dispatchId: 'docs-dispatch',
                        agent: 'claude',
                        status: 'dispatched',
                        worktreeId: docs.id,
                        result: null,
                        failure: null
                      },
                      deliveries: []
                    }
                  ]
                }
              ]
            : []
        })
      }
      case 'orchestration.entryApprovals':
        return respond({ approvals: [] })
      case 'orchestration.entryAgents':
        return respond({ agents: [] })
      default:
        return original(request)
    }
  }
}

function DispatchWorktreesFixture(): React.JSX.Element {
  const dispatchEntry = useDispatchEntryPaneListener()
  const layout = useAppChromeLayout(dispatchEntry.target !== null)
  const floatingWorkspace = useFloatingWorkspacePanel()
  useEffect(() => openDispatchEntry(project.id, 'local'), [])
  return (
    <div className="flex h-[550px] flex-col">
      <div className="flex flex-wrap gap-2 border-b p-2 text-xs">
        <button type="button" onClick={() => openDispatchEntry(project.id, 'local')}>
          Inventory dispatch
        </button>
        <button type="button" onClick={() => openDispatchEntry(other.id, 'local')}>
          Website dispatch
        </button>
        <button
          type="button"
          onClick={() =>
            useAppStore.setState({
              activeWorktreeId: website.id,
              activeWorkspaceExecutionHostId: 'local'
            })
          }
        >
          Switch to Website checkout
        </button>
      </div>
      <AppWorkspaceShell
        layout={{ ...layout, showSidebar: false, shouldMountTerminalWorkbench: false }}
        floatingWorkspace={floatingWorkspace}
        dispatchEntry={dispatchEntry}
      />
    </div>
  )
}

export const projectSidebar = defineFixture({
  width: 980,
  setup,
  store: {
    activeView: 'terminal',
    activeWorktreeId: main.id,
    activeWorkspaceExecutionHostId: 'local',
    rightSidebarOpen: true,
    rightSidebarTab: 'explorer',
    rightSidebarWidth: 340,
    repos: [project, other, { ...project, executionHostId: 'runtime:other-host' }],
    worktreesByRepo: { [project.id]: [main, docs, foreign], [other.id]: [website] },
    detectedWorktreesByRepo: {
      [project.id]: {
        repoId: project.id,
        authoritative: true,
        source: 'git',
        worktrees: [{ ...hidden, ownership: 'external', selectedCheckout: false, visible: false }]
      }
    }
  },
  render: () => (
    <ConfirmationDialogProvider>
      <DispatchWorktreesFixture />
    </ConfirmationDialogProvider>
  )
})
