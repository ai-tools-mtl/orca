import { recordEntryAssignmentError } from './entry-assignment-errors'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { RunRow } from '../../../orchestration/db/orchestration-records'
import { desktopEntryCaller } from '../../../orchestration/addressing/desktop-entry-identity'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { pickTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-selection'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { entrySubActionNeedsReadOnly } from '../../../orchestration/routing/entry-write-policy'
import {
  resolveStageUpstream,
  type StageUpstream
} from '../../../orchestration/routing/routing-stage-gates'
import { startLocalWorker } from './worker/start/local-worker-start'
import { assertWorkerStartTaskSpecWithinPromptBudget } from './worker/start/admission/worker-start-prompt-budget'
import {
  decideWorkerStartMode,
  readWorkerStartModeSettings
} from './structured-workers/orchestration-worker-start-mode'
import { parseWorkerReport } from './entry-reviewer-pick'
import { entryPlacement, type EntryPlacement } from './entry-placement'

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
  // 阶段链 (entry-stage-pipeline-plan §6): a stage dispatches only after its upstreams settled,
  // their gates granted and their plans usable — the same guard protects the pump path and a
  // manual entryAssign from jumping the gate.
  const upstream = resolveStageUpstream(db, action)
  if (upstream && upstream.blockedOn.length > 0) {
    throw new OrchestrationError(
      'lifecycle_conflict',
      `上游阶段尚未验收：${upstream.blockedOn.join('、')}`,
      { subActionId, blockedOn: upstream.blockedOn }
    )
  }
  const candidate = placement.agents.find((available) => available === agent)
  if (!candidate) {
    throw new OrchestrationError(
      'agent_unconfigured',
      `Worker ${agent} is unavailable on this project host.`
    )
  }
  const readOnly = entrySubActionNeedsReadOnly(db, action)
  if (readOnly && (candidate !== 'codex' || !placement.supportsReadOnly)) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'This investigation requires a Codex structured session with read-only sandbox support.'
    )
  }
  const spec = [
    action.text,
    ...readConstraints(action.constraints_json),
    ...upstreamReportLines(db, upstream),
    ...(readOnly
      ? [
          'Investigate without modifying project files. Present your findings before requesting explicit approval for any write. A follow-up message does not grant write access. If an approval is interrupted, wait for the user to decide before reporting completion.'
        ]
      : [])
  ].join('\n')
  await assertWorkerStartTaskSpecWithinPromptBudget(spec)

  // The chain shares the upstream worker's workspace (§6 同 worktree 交接).
  const boundWorktreeId = upstream?.worktreeId
  const { folderId } = placement
  const folderInPlay = boundWorktreeId ?? folderId
  const starting = folderStarts.get(db) ?? new Set<string>()
  folderStarts.set(db, starting)
  if (folderInPlay) {
    if (starting.has(folderInPlay) || folderWorkerOccupied(db, folderInPlay)) {
      if (action.stage_kind) {
        // The chain serializes through the dependency gate; another worker holding the
        // directory just waits for the next pump pass instead of the shared queue.
        return { queued: false }
      }
      // §5.6 同目录排队: the folder is occupied (running or paused counts) — the sub-action
      // waits and the entry pump dispatches the earliest waiter once the folder frees.
      db.queueRoutingSubAction(subActionId)
      return { queued: true }
    }
    starting.add(folderInPlay)
  }
  try {
    const coordinator = desktopEntryCaller(group)
    const params = {
      from: coordinator.address,
      spec,
      taskTitle: action.text,
      agent: candidate,
      ...(boundWorktreeId
        ? // 绑定已有 worktree 不带 setup：setup 是创建参数，带上会被 worker-start 守卫拒绝。
          { worktree: `id:${boundWorktreeId}` }
        : folderId
          ? { worktree: `id:${folderId}` }
          : {
              worktree: 'new-top-level',
              repo: placement.repo,
              setup: readOnly ? ('skip' as const) : ('inherit' as const),
              ...(placement.baseFallback ? { baseBranch: placement.baseFallback } : {}),
              bootstrapIfUnborn: !readOnly && placement.unborn === true
            })
    }
    await startLocalWorker({
      params,
      runtime,
      db,
      bindRun: () => run,
      coordinator,
      taskDeps: undefined,
      mode: decideWorkerStartMode({
        params,
        settings: readWorkerStartModeSettings(runtime),
        readOnly
      }),
      entrySubActionId: subActionId,
      readOnly
    })
    db.dequeueRoutingSubAction(subActionId)
    return { queued: false }
  } finally {
    if (folderInPlay) {
      starting.delete(folderInPlay)
    }
  }
}

/** 与设置页"默认 · 自动"同源的默认 agent 解析：显式默认（宿主可用性校验）→ 目录顺序自动选。 */
export function entryPreferredAgent(
  placement: EntryPlacement,
  settings: Partial<Pick<GlobalSettings, 'defaultTuiAgent' | 'disabledTuiAgents'>>
): TuiAgent | null {
  return pickTuiAgent(settings.defaultTuiAgent, placement.agents, settings.disabledTuiAgents)
}

/** The entry's agent pick for one sub-action: explicit read-only investigations need a Codex
 *  structured session; everything else takes the settings default, else Codex, else anyone. */
export function entryAgentFor(
  placement: EntryPlacement,
  preferred: string | null | undefined,
  readOnly: boolean
): string | undefined {
  if (readOnly) {
    return placement.agents.find((available) => available === 'codex' && placement.supportsReadOnly)
  }
  const preferredAgent =
    preferred && preferred !== 'blank'
      ? placement.agents.find((candidate) => candidate === preferred)
      : undefined
  return (
    preferredAgent ??
    placement.agents.find((candidate) => candidate === 'codex') ??
    placement.agents[0]
  )
}

/** §5.6 占用: a folder is occupied while its worker is starting or running — a paused worker
 *  still holds the directory (占用仍保留). Only a confirmed end frees it. */
export function folderWorkerOccupied(db: OrchestrationDb, folderId: string): boolean {
  return db
    .listWorkerTerminalResources()
    .some(
      (worker) =>
        worker.worktreeId === folderId &&
        (worker.dispatchStatus === 'pending' || worker.dispatchStatus === 'dispatched')
    )
}

function readConstraints(raw: string): string[] {
  const entries: unknown = JSON.parse(raw)
  return Array.isArray(entries) ? entries.filter((value) => typeof value === 'string') : []
}

/** Upstream stage reports flow into the downstream spec (§6 数据流): subject, trimmed body and
 *  the touched files — what the review loop already feeds its rework spawns. */
function upstreamReportLines(db: OrchestrationDb, upstream: StageUpstream | null): string[] {
  if (!upstream) {
    return []
  }
  const lines: string[] = []
  for (const row of upstream.rows) {
    const task = row.task_id ? db.getTask(row.task_id) : undefined
    const report = parseWorkerReport(task?.result ?? null)
    if (!report) {
      continue
    }
    lines.push(`上游阶段「${row.text}」结果：`)
    if (report.subject) {
      lines.push(report.subject)
    }
    if (report.body) {
      const body = report.body.trim()
      lines.push(body.length > 4000 ? `${body.slice(0, 4000)}…` : body)
    }
    if (report.filesModified?.length) {
      lines.push(`改动文件：${report.filesModified.join('、')}`)
    }
  }
  return lines
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
  const subActions = db
    .listSubActions(inputId)
    .filter((action) => !action.task_id && !action.stage_kind)
  if (subActions.length === 0) {
    return []
  }
  return entryPlacement(runtime, group).then(
    (placement) => {
      const preferred = entryPreferredAgent(placement, runtime.requireStore().getSettings())
      return Promise.all(
        subActions.map(async (action) => {
          const readOnly = entrySubActionNeedsReadOnly(db, action)
          // A proposal is only a preference: it must exist on this project host, or the generic
          // pick takes over (the decision model can drift from the capability list it was shown).
          const proposed = args.agents.get(action.sub_action_id)
          const agent =
            (!readOnly && proposed && placement.agents.includes(proposed) ? proposed : undefined) ??
            entryAgentFor(placement, preferred, readOnly)
          if (!agent) {
            const reason = readOnly
              ? 'This investigation requires a Codex structured session with read-only sandbox support.'
              : preferred
                ? `The default worker ${preferred} is unavailable on this project host.`
                : 'No workers detected on this project host.'
            return recordEntryAssignmentError(db, inputId, action.sub_action_id, reason)
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
            return recordEntryAssignmentError(db, inputId, action.sub_action_id, error)
          }
        })
      )
    },
    (error: unknown) =>
      subActions.map((action) =>
        recordEntryAssignmentError(db, inputId, action.sub_action_id, error)
      )
  )
}
