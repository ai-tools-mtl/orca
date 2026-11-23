import { recordEntryAssignmentError } from './entry-assignment-errors'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { RunRow } from '../../../orchestration/db/orchestration-records'
import type { RoutingSubActionRow } from '../../../orchestration/db/routing-records'
import { routingInputDispatchAuthorized } from '../../../orchestration/routing/dispatch-authorization'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import { pumpFailedStages, pumpZombieSettlements } from './entry-failed-stage-fallback'
import { splitWorktreeIdForFilesystem } from '../../../../../shared/worktree/id'
import { desktopEntryCaller } from '../../../orchestration/addressing/desktop-entry-identity'
import { parseOrcaPlan, savedOrcaPlanStages } from '../../../orchestration/routing/orca-plan-parse'
import { recoverOrcaPlanFromReportFiles } from '../../../orchestration/routing/orca-plan-file-recovery'
import { resolveStageUpstream } from '../../../orchestration/routing/routing-stage-gates'
import { mergeEntryChainWorktree } from '../../../../git/source-control/mutations/entry-chain-merge'
import {
  dispatchEntrySubAction,
  entryAgentFor,
  entryPreferredAgent,
  folderWorkerOccupied
} from './entry-dispatch'
import { resumeEntryUndeliveredTaskReferences, taskReferenceRows } from './entry-supplements'
import { entrySubActionNeedsReadOnly } from '../../../orchestration/routing/entry-write-policy'
import { entryPlacement } from './entry-placement'
import { startLocalWorker } from './worker/start/local-worker-start'
import {
  decideWorkerStartMode,
  readWorkerStartModeSettings
} from './structured-workers/orchestration-worker-start-mode'
import { parseWorkerReport } from './entry-reviewer-pick'
import { pumpReviewLoops, type EntryLoopSpawn } from './entry-review-loop'

// The entry's automation pump (§5.6/§7): idempotent housekeeping the entry RPCs run on every
// touch (the pane polls entryShow every 2s while open, so the loop and the folder queue advance
// in near-real time). Workers keep running while the pane is closed; bookkeeping catches up on
// the next touch.

type PumpArgs = {
  runtime: OrcaRuntimeService
  run: RunRow
  group: string
}

/** Injectable so the state-machine tests stub the spawn instead of the runtime. */
export type EntryDispatchSubAction = typeof dispatchEntrySubAction

export type { EntryLoopSpawn }

export async function pumpEntryAutomations(
  args: PumpArgs,
  dispatchSubAction: EntryDispatchSubAction = dispatchEntrySubAction,
  spawnLoopWorker?: EntryLoopSpawn
): Promise<void> {
  await pumpFolderQueue(args, dispatchSubAction)
  // 恢复推进在前：崩溃落在登记与受理之间的动作先补齐，阶段门照常自行推进。
  await pumpAuthorizedDispatches(args, dispatchSubAction)
  // Review rounds first: an acceptance in this pass can unblock the next stage below.
  await pumpReviewLoops(args, spawnLoopWorker ?? defaultLoopSpawn(args))
  // 僵尸结算最先跑：限流终局的 dispatch 不结算就永远占住链工作树（folderWorkerOccupied），
  // 后续所有重派/派发都会被静默挡在门外。
  await pumpZombieSettlements(args)
  // 失败兜底先于阶段门：重绑过的行（agent_hint 已钉成兜底 agent）在同一轮就能被重新受理。
  await pumpFailedStages(args, dispatchSubAction)
  await pumpStageGates(args, dispatchSubAction)
}

function defaultLoopSpawn(args: PumpArgs): EntryLoopSpawn {
  const { runtime, run, group } = args
  const coordinator = desktopEntryCaller(group)
  const modeSettings = readWorkerStartModeSettings(runtime)
  return async (spawn) => {
    const db = runtime.getOrchestrationDb()
    const params = {
      from: coordinator.address,
      spec: spawn.spec,
      taskTitle: spawn.taskTitle,
      agent: spawn.agent,
      worktree: `id:${spawn.worktreeId}`,
      setup: 'skip' as const
    }
    return startLocalWorker({
      params,
      runtime,
      db,
      bindRun: () => run,
      taskDeps: undefined,
      coordinator,
      mode: decideWorkerStartMode({ params, settings: modeSettings, readOnly: spawn.readOnly }),
      readOnly: spawn.readOnly,
      entryReviewIntentId: spawn.intentId
    })
  }
}

// ---------------------------------------------------------------- 派发恢复（§重放与恢复）

/** 恢复推进：已授权（dispatch=true 触达过）但登记后从未受理的动作补齐。崩溃可能发生在
 *  决定登记与 Worker 受理之间——「尚未受理且可证明从未执行」的普通行由泵经同一派发入口
 *  补派，续接（任务绑定行）由恢复投递补登记。幂等：已绑定/已认领/已排队/已暂停/已报错的
 *  普通行跳过，已有投递记录的续接不重投；运行级暂停时不推进。 */
async function pumpAuthorizedDispatches(args: PumpArgs, dispatchSubAction: EntryDispatchSubAction) {
  const { runtime, run, group } = args
  const db = runtime.getOrchestrationDb()
  if (db.isRoutingRunPaused(run.id)) {
    return
  }
  const pending: RoutingSubActionRow[] = []
  const authorizedInputIds: string[] = []
  for (const input of db.listRunRoutingInputs(run.id)) {
    if (!routingInputDispatchAuthorized(input)) {
      continue
    }
    authorizedInputIds.push(input.input_id)
    for (const action of db.listSubActions(input.input_id)) {
      if (
        action.stage_kind ||
        action.task_id ||
        action.claimed_dispatch_id ||
        action.paused_at ||
        action.queued_at ||
        action.entry_error
      ) {
        continue
      }
      pending.push(action)
    }
  }
  // 已授权但从未登记投递的续接先补登记（零投递记录 = 可证明从未受理）。
  for (const inputId of authorizedInputIds) {
    try {
      await resumeEntryUndeliveredTaskReferences(db, inputId)
    } catch (error) {
      for (const action of taskReferenceRows(db, inputId)) {
        if (db.listSupplements(action.sub_action_id).length === 0) {
          recordEntryAssignmentError(db, inputId, action.sub_action_id, error)
        }
      }
    }
  }
  if (pending.length === 0) {
    return
  }
  const placement = await entryPlacement(runtime, group).catch(() => undefined)
  if (!placement) {
    return
  }
  const preferred = entryPreferredAgent(placement, runtime.requireStore().getSettings())
  for (const action of pending) {
    const readOnly = entrySubActionNeedsReadOnly(db, action)
    const agent = entryAgentFor(placement, preferred, readOnly)
    if (!agent) {
      recordEntryAssignmentError(
        db,
        action.input_id,
        action.sub_action_id,
        readOnly
          ? 'This investigation requires a Codex structured session with read-only sandbox support.'
          : 'No workers detected on this project host.'
      )
      continue
    }
    try {
      await dispatchSubAction({
        runtime,
        run,
        group,
        inputId: action.input_id,
        subActionId: action.sub_action_id,
        agent,
        placement
      })
    } catch (error) {
      recordEntryAssignmentError(db, action.input_id, action.sub_action_id, error)
    }
  }
}

// ---------------------------------------------------------------- 阶段依赖门（pipeline §6）

/** 阶段化生命周期: settle the plan stage's orca-plan payload once its worker reported, then
 *  dispatch every stage whose upstreams settled, gates granted and plans usable. Blocked
 *  stages stay pending and re-verify on the next pump pass — never queued, never re-dispatched. */
/** The dispatched stage's workspace directory — the plan-recovery probe reads report files there. */
function stageWorktreePath(db: OrchestrationDb, taskId: string): string | undefined {
  const dispatch = db.getDispatchContext(taskId)
  const launch = dispatch ? db.getWorkerDispatch(dispatch.id) : undefined
  const worktreeId = launch?.worktree_id
  return worktreeId
    ? (splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? undefined)
    : undefined
}

async function pumpStageGates(args: PumpArgs, dispatchSubAction: EntryDispatchSubAction) {
  const { runtime, run, group } = args
  const db = runtime.getOrchestrationDb()
  const pending: RoutingSubActionRow[] = []
  for (const input of db.listRunRoutingInputs(run.id)) {
    // 自动派发以持久化授权为准（§派发授权）：只有 dispatch=true 通过权限检查后写入的
    // dispatchAuthorized 让阶段推进器动起来；未授权（hold/旧中断产物/手动未确认）一律跳过。
    if (!routingInputDispatchAuthorized(input)) {
      continue
    }
    for (const action of db.listSubActions(input.input_id)) {
      if (!action.stage_kind) {
        continue
      }
      if (
        action.stage_kind === 'plan' &&
        action.task_id &&
        !savedOrcaPlanStages(action.plan_json)
      ) {
        const task = db.getTask(action.task_id)
        if (task?.status === 'completed') {
          const report = parseWorkerReport(task.result)
          const parsed = parseOrcaPlan(report?.body ?? null)
          // 报告正文没有围栏块时，找回 worker 存进工作树的计划文件（§5 恢复）。
          const recovered =
            parsed.status === 'missing' && report
              ? recoverOrcaPlanFromReportFiles(report, stageWorktreePath(db, task.id))
              : null
          db.saveRoutingPlanParse(action.sub_action_id, recovered ?? parsed)
        }
      }
      if (action.stage_kind === 'merge' && !action.merged_at) {
        if (action.paused_at) {
          continue
        }
        // 合并检查点（§8）：链尾门在授权后执行；中间里程碑（auto，计划确认已覆盖其授权）在
        // 上游 settle 后由系统直接执行——失败升级为人工确认，不静默自动重试。
        const autoCheckpoint = action.gate === 'auto'
        if (autoCheckpoint) {
          // 自动里程碑：上游全部 settle 才执行，否则等下一轮泵。
          if (resolveStageUpstream(db, action)?.blockedOn.length) {
            continue
          }
        } else if (!(action.gate === 'user_confirm' && action.gate_granted_at)) {
          continue
        }
        const chainPath = resolveStageUpstream(db, action)?.worktreeId
        if (chainPath) {
          const outcome = await mergeEntryChainWorktree({
            chainWorktreePath: splitWorktreeIdForFilesystem(chainPath)?.worktreePath ?? '',
            commitMessage: action.text
          })
          if (autoCheckpoint && !outcome.ok) {
            db.promoteRoutingMergeCheckpoint(action.sub_action_id, outcome.error)
          } else {
            db.recordRoutingMergeOutcome(
              action.sub_action_id,
              outcome.ok
                ? { ok: true, receiptJson: JSON.stringify(outcome.receipt) }
                : { ok: false, error: outcome.error }
            )
          }
        }
        continue
      }
      if (action.task_id || action.paused_at) {
        continue
      }
      if (resolveStageUpstream(db, action)?.blockedOn.length) {
        continue
      }
      pending.push(action)
    }
  }
  if (pending.length === 0) {
    return
  }
  const placement = await entryPlacement(runtime, group).catch(() => undefined)
  if (!placement) {
    return
  }
  const preferred = entryPreferredAgent(placement, runtime.requireStore().getSettings())
  for (const action of pending) {
    // The plan's agent hint is a preference: it must exist on this host, else the generic pick.
    const hint = action.agent_hint && isTuiAgent(action.agent_hint) ? action.agent_hint : undefined
    const readOnly = entrySubActionNeedsReadOnly(db, action)
    const agent =
      (!readOnly && hint && placement.agents.includes(hint) ? hint : undefined) ??
      entryAgentFor(placement, preferred, readOnly)
    if (!agent) {
      continue
    }
    try {
      await dispatchSubAction({
        runtime,
        run,
        group,
        inputId: action.input_id,
        subActionId: action.sub_action_id,
        agent,
        placement
      })
    } catch (error) {
      recordEntryAssignmentError(db, action.input_id, action.sub_action_id, error)
    }
  }
}

// ---------------------------------------------------------------- 同目录排队（§5.6）

async function pumpFolderQueue(args: PumpArgs, dispatchSubAction: EntryDispatchSubAction) {
  const { runtime, run, group } = args
  const db = runtime.getOrchestrationDb()
  const queued = db.listQueuedSubActions(run.id)
  if (queued.length === 0) {
    return
  }
  const placement = await entryPlacement(runtime, group)
  const preferred = entryPreferredAgent(placement, runtime.requireStore().getSettings())
  for (const action of queued) {
    if (action.task_id) {
      // Started by some other path while queued — the queue entry is stale.
      db.dequeueRoutingSubAction(action.sub_action_id)
      continue
    }
    if (action.paused_at || !placement.folderId) {
      continue
    }
    if (folderWorkerOccupied(db, placement.folderId)) {
      continue
    }
    const readOnly = entrySubActionNeedsReadOnly(db, action)
    const agent = entryAgentFor(placement, preferred, readOnly)
    if (!agent) {
      continue
    }
    try {
      await dispatchSubAction({
        runtime,
        run,
        group,
        inputId: action.input_id,
        subActionId: action.sub_action_id,
        agent,
        placement
      })
      db.dequeueRoutingSubAction(action.sub_action_id)
    } catch (error) {
      recordEntryAssignmentError(db, action.input_id, action.sub_action_id, error)
    }
  }
}
