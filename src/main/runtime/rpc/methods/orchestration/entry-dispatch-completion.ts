import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import type { RunRow } from '../../../orchestration/db/orchestration-records'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RoutedDecision } from '../../../orchestration/routing/routing-router'
import { dispatchEntryTaskReferences } from './entry-supplements'
import { dispatchEntryDecision } from './entry-dispatch'

// 派发完成（按输入串行）：区分「决定已登记」与「派发已受理」的最后一步。幂等——
// dispatchEntryDecision 只碰尚未绑定任务的普通子动作；派发保持清除后阶段交还推进器。

export type EntryRouteOutcome = {
  decision: RoutedDecision
  run: RunRow
}

export type EntryDispatchCompletion = EntryRouteOutcome & { decision: EntryAutoRouteResult }

export type EntryAutoRouteResult = RoutedDecision & { dispatchErrors?: string[] }

const inFlightEntryDispatches = new Map<string, Promise<EntryDispatchCompletion>>()

export function completeEntryDispatch(args: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  group: string
  inputId: string
  routed: EntryRouteOutcome
}): Promise<EntryDispatchCompletion> {
  const key = args.inputId
  const pending = inFlightEntryDispatches.get(key)
  if (pending) {
    return pending
  }
  const { db, runtime } = args
  const { decision, run } = args.routed
  const promise = (async (): Promise<EntryDispatchCompletion> => {
    // 授权先于一切派发动作原子落定（一次 UPDATE）：只有通过权限检查的 dispatch=true 才
    // 到达这里。续接投递在授权落库后才开始——中断只会留下「已授权未受理」的行由泵补齐；
    // 「未授权却有补充记录」的中间态不存在。
    db.grantRoutingDispatch(args.inputId)
    const references = dispatchEntryTaskReferences(db, args.inputId)
    const [, errors] = await Promise.all([
      references,
      dispatchEntryDecision({
        runtime,
        run,
        group: args.group,
        inputId: args.inputId,
        agents: new Map(
          decision.subActions.flatMap((action) =>
            action.agent ? [[action.sub_action_id, action.agent]] : []
          )
        )
      })
    ])
    return {
      decision: { ...decision, dispatchErrors: errors.filter((error) => error !== null) },
      run
    }
  })().finally(() => {
    if (inFlightEntryDispatches.get(key) === promise) {
      inFlightEntryDispatches.delete(key)
    }
  })
  inFlightEntryDispatches.set(key, promise)
  return promise
}
