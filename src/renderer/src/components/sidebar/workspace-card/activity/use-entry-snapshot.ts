import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { readEntrySnapshot, type RoutingEntryApproval } from './entry-facts-rpc'
import type { RoutingEntryInput, RoutingReviewState } from './routing-entry-model'

/** The entry's snapshot state (§10：renderer 不存第二份流程状态)——entryShow 是唯一读取。
 *  面板开着就 2s 轮询且挂载即拉首帧：entryShow 兼作泵的心跳（泵推进在 entryShow 里，
 *  §5.6/§7），闲置停表会让阶段链在"上游完成→下游未派发"的窗口期卡死，首帧缺失则空态。
 *  busy 不参与：它是用户操作的互斥态（composer 禁用），轮询刷新不该碰。 */
export function useEntrySnapshot(target: RuntimeClientTarget | null, group: string) {
  const [inputs, setInputs] = useState<RoutingEntryInput[]>([])
  const [hasSnapshot, setHasSnapshot] = useState(false)
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reviews, setReviews] = useState<ReadonlyMap<string, RoutingReviewState>>(new Map())
  const [approvals, setApprovals] = useState<RoutingEntryApproval[]>([])

  const refreshVersion = useRef(0)
  const refresh = useCallback(async () => {
    if (!target) {
      return
    }
    const version = ++refreshVersion.current
    await readEntrySnapshot(target, group).then(
      (snapshot) => {
        if (version !== refreshVersion.current) {
          return
        }
        setInputs(snapshot.inputs)
        setHasSnapshot(true)
        setPaused(snapshot.paused)
        setReviews(snapshot.reviews)
        setApprovals(snapshot.approvals)
        setError(null)
      },
      (cause: unknown) => {
        if (version === refreshVersion.current) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
    )
  }, [target, group])

  useEffect(() => {
    if (!target) {
      return
    }
    let disposed = false
    let timer = 0
    function poll(): void {
      void refresh().then(() => {
        if (!disposed) {
          timer = window.setTimeout(poll, 2000)
        }
      })
    }
    poll()
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [target, group, refresh])

  return { inputs, hasSnapshot, paused, error, reviews, approvals, refresh }
}
