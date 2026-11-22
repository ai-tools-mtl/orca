// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc }))

// 提交快照单独打桩：这里只考察 submit 的请求 ID 语义，不关心账本读取。
const refresh = vi.fn(async () => {})
vi.mock('./use-entry-snapshot', () => ({
  useEntrySnapshot: () => ({
    inputs: [],
    paused: false,
    error: null,
    reviews: [],
    approvals: [],
    refresh
  })
}))

import { useRoutingEntryFacts } from './use-routing-entry-facts'

// 提交重试（§提交去重）：请求 ID 在服务端确认前保持不变——响应丢失后重发原草稿复用同一
// ID，账本只登记一条；确认成功后相同文本是新提交、新 ID；失败后改写内容换新 ID，避免撞
// 服务端的「同 ID 不同内容」冲突。
describe('entry submit request ids across retries', () => {
  afterEach(() => {
    callRuntimeRpc.mockReset()
    refresh.mockClear()
  })

  function renderFacts() {
    return renderHook(() => useRoutingEntryFacts({ kind: 'local' }, 'proj_retry'))
  }

  function submitIds() {
    return callRuntimeRpc.mock.calls
      .filter(([, method]) => method === 'orchestration.entrySubmit')
      .map(([, , params]) => (params as { requestId: string }).requestId)
  }

  it('reuses the request id when resending the same draft after a failed submit', async () => {
    callRuntimeRpc
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce({ input: { input_id: 'rinp_ok' } })
    const { result } = renderFacts()
    await act(async () => {
      await expect(result.current.submit('修登录')).rejects.toThrow('connection lost')
    })
    await act(async () => {
      await result.current.submit('修登录')
    })
    const ids = submitIds()
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
  })

  it('sends a new request id for the same text after a successful submit', async () => {
    callRuntimeRpc.mockResolvedValue({ input: { input_id: 'rinp_ok' } })
    const { result } = renderFacts()
    await act(async () => {
      await result.current.submit('修登录')
    })
    await act(async () => {
      await result.current.submit('修登录')
    })
    const ids = submitIds()
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('switches to a new request id when a failed draft is resubmitted with different content', async () => {
    callRuntimeRpc
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce({ input: { input_id: 'rinp_ok' } })
    const { result } = renderFacts()
    await act(async () => {
      await expect(result.current.submit('修登录')).rejects.toThrow('connection lost')
    })
    await act(async () => {
      await result.current.submit('查启动慢')
    })
    const ids = submitIds()
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    // 内容改写后的提交带上新 ID 和新文本。
    const params = callRuntimeRpc.mock.calls[1]?.[2] as { text: string }
    expect(params.text).toBe('查启动慢')
  })

  it('keeps the loop option in the retry of an unacknowledged loop submission', async () => {
    callRuntimeRpc
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce({ input: { input_id: 'rinp_ok' } })
    const { result } = renderFacts()
    await act(async () => {
      await expect(result.current.submit('修登录', { loop: true })).rejects.toThrow(
        'connection lost'
      )
    })
    await act(async () => {
      await result.current.submit('修登录', { loop: true })
    })
    const ids = submitIds()
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    for (const [, , params] of callRuntimeRpc.mock.calls) {
      expect((params as { loop?: boolean }).loop).toBe(true)
    }
  })

  it('clears the pending request id once the snapshot refresh settles', async () => {
    callRuntimeRpc.mockResolvedValue({ input: { input_id: 'rinp_ok' } })
    const { result } = renderFacts()
    await act(async () => {
      await result.current.submit('修登录')
    })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    await act(async () => {
      await result.current.submit('修登录')
    })
    expect(submitIds()[0]).not.toBe(submitIds()[1])
  })
})
