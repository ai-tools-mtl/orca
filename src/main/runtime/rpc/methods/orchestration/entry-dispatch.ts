import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { RunRow } from '../../../orchestration/db/orchestration-records'
import { desktopEntryCaller } from '../../../orchestration/addressing/desktop-entry-identity'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { workerStartOptionsAgent } from '../../../orchestration/workers/launch/worker-launch-observation'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { startLocalWorker } from './worker/start/local-worker-start'
import { assertWorkerStartTaskSpecWithinPromptBudget } from './worker/start/admission/worker-start-prompt-budget'
import {
  decideWorkerStartMode,
  readWorkerStartModeSettings
} from './structured-workers/orchestration-worker-start-mode'
import { routingInputsPayload } from './routing-supplements'

export function coordinatedEntryRun(db: OrchestrationDb, group: string) {
  const caller = desktopEntryCaller(group)
  const run = db.getCurrentRunForCoordinator(caller)
  if (!run) {
    throw new OrchestrationError(
      'run_required',
      `The entry for ${group} has no Run yet; record a request first.`
    )
  }
  return { caller, run }
}

export function entryRunOfInput(db: OrchestrationDb, group: string, inputId: string) {
  const { run } = coordinatedEntryRun(db, group)
  const input = db.getRoutingInput(inputId)
  if (!input || input.run_id !== run.id) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Input ${inputId} does not belong to the entry Run of ${group}.`,
      { inputId }
    )
  }
  return run
}

type EntryPlacement = {
  agents: TuiAgent[]
  repo: string
  folderId?: string
}

export async function entryPlacement(
  runtime: OrcaRuntimeService,
  group: string
): Promise<EntryPlacement> {
  const repo = `id:${group}`
  const launch = await runtime.detectProjectLaunchContext(repo)
  if (launch.workspaceKind !== 'folder') {
    return { repo, agents: launch.agents }
  }
  const { worktrees } = await runtime.listManagedWorktrees(repo)
  const workspace = worktrees[0]
  if (!workspace) {
    throw new OrchestrationError('invalid_argument', 'The project folder workspace is unavailable.')
  }
  return { repo, agents: launch.agents, folderId: workspace.id }
}

const folderStarts = new WeakMap<OrchestrationDb, Set<string>>()

export async function dispatchEntrySubAction(args: {
  runtime: OrcaRuntimeService
  run: RunRow
  group: string
  inputId: string
  subActionId: string
  agent: string
  placement: EntryPlacement
}) {
  const { runtime, run, group, inputId, subActionId, agent, placement } = args
  const db = runtime.getOrchestrationDb()
  const action = db.getSubAction(subActionId)
  if (action?.input_id !== inputId || action.run_id !== run.id) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      'The sub-action does not belong to this input.'
    )
  }
  if (action.task_id !== null) {
    return
  }
  const candidate = placement.agents.find((available) => available === agent)
  if (!candidate) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Worker ${agent} is unavailable on this project host.`
    )
  }
  const spec = [action.text, ...readConstraints(action.constraints_json)].join('\n')
  await assertWorkerStartTaskSpecWithinPromptBudget(spec)

  const { folderId } = placement
  const starting = folderStarts.get(db) ?? new Set<string>()
  folderStarts.set(db, starting)
  if (folderId) {
    if (
      starting.has(folderId) ||
      db
        .listWorkerTerminalResources()
        .some(
          (worker) =>
            worker.worktreeId === folderId &&
            (worker.dispatchStatus === 'pending' || worker.dispatchStatus === 'dispatched')
        )
    ) {
      throw new OrchestrationError(
        'lifecycle_conflict',
        'A worker is already running in this project folder.'
      )
    }
    starting.add(folderId)
  }
  try {
    const coordinator = desktopEntryCaller(group)
    const params = {
      from: coordinator.address,
      spec,
      taskTitle: action.text,
      agent: candidate,
      ...(folderId
        ? { worktree: `id:${folderId}` }
        : { worktree: 'new-top-level', repo: placement.repo, setup: 'inherit' as const })
    }
    await startLocalWorker({
      params,
      runtime,
      db,
      bindRun: () => run,
      coordinator,
      taskDeps: undefined,
      mode: decideWorkerStartMode({ params, settings: readWorkerStartModeSettings(runtime) }),
      entrySubActionId: subActionId
    })
  } finally {
    if (folderId) {
      starting.delete(folderId)
    }
  }
}

function readConstraints(raw: string): string[] {
  const entries: unknown = JSON.parse(raw)
  return Array.isArray(entries) ? entries.filter((value) => typeof value === 'string') : []
}

export async function dispatchEntryDecision(args: {
  runtime: OrcaRuntimeService
  run: RunRow
  group: string
  inputId: string
  agents: ReadonlyMap<string, TuiAgent>
}) {
  const { runtime, run, group, inputId } = args
  const db = runtime.getOrchestrationDb()
  const subActions = db.listSubActions(inputId)
  if (subActions.every((action) => action.task_id !== null)) {
    return []
  }
  const placement = await entryPlacement(runtime, group)
  const preferred = runtime.requireStore().getSettings().defaultTuiAgent
  const defaultAgent =
    preferred && preferred !== 'blank'
      ? placement.agents.find((candidate) => candidate === preferred)
      : (placement.agents.find((candidate) => candidate === 'codex') ?? placement.agents[0])
  return Promise.all(
    subActions
      .filter((action) => action.task_id === null)
      .map(async (action) => {
        const agent = args.agents.get(action.sub_action_id) ?? defaultAgent
        if (!agent) {
          return preferred && preferred !== 'blank'
            ? `The default worker ${preferred} is unavailable on this project host.`
            : 'No workers detected on this project host.'
        }
        try {
          await dispatchEntrySubAction({
            runtime,
            run,
            group,
            inputId,
            agent,
            placement,
            subActionId: action.sub_action_id
          })
          return null
        } catch (error: unknown) {
          return error instanceof Error ? error.message : String(error)
        }
      })
  )
}

export function entryInputsWithResults(db: OrchestrationDb, runId: string) {
  const tasks = new Map(db.listTasks({ runId }).map((task) => [task.id, task]))
  const errors = new Map<string, string>()
  for (const message of db.getAllMessagesForHandle(`run:${runId}`, 100, ['escalation'], runId)) {
    const report = parseEntryJson(message.payload)
    if (
      report &&
      'dispatchId' in report &&
      typeof report.dispatchId === 'string' &&
      'error' in report &&
      typeof report.error === 'string' &&
      !errors.has(report.dispatchId)
    ) {
      errors.set(report.dispatchId, report.error)
    }
  }
  return {
    inputs: routingInputsPayload(db, runId).inputs.map((input) => ({
      ...input,
      subActions: input.subActions.map((entry) => {
        const taskId = entry.subAction.task_id
        const task = taskId ? tasks.get(taskId) : undefined
        const dispatch = task && db.getDispatchContext(task.id)
        const launch = dispatch && db.getWorkerDispatch(dispatch.id)
        const active = dispatch?.status === 'pending' || dispatch?.status === 'dispatched'
        const reportedError = dispatch && active ? errors.get(dispatch.id) : undefined
        return {
          ...entry,
          execution:
            task && dispatch
              ? {
                  agent: launch ? workerStartOptionsAgent(launch.start_options) : null,
                  dispatchId: dispatch.id,
                  status: reportedError ? ('attention' as const) : dispatch.status,
                  result: entryResultText(task.result),
                  failure: reportedError ?? launch?.last_error ?? dispatch.last_failure
                }
              : null
        }
      })
    }))
  }
}

function entryResultText(result: string | null): string | null {
  const value = parseEntryJson(result)
  if (value && 'provenance' in value && value.provenance === 'worker_report') {
    return (
      ('body' in value && typeof value.body === 'string' && value.body.trim()) ||
      ('subject' in value && typeof value.subject === 'string' && value.subject) ||
      null
    )
  }
  return result
}

function parseEntryJson(text: string | null): object | undefined {
  if (!text?.startsWith('{')) {
    return
  }
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}
