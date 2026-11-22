import { useEffect, useState } from 'react'

type ReadResult<T> = { value: T; error?: never } | { value?: never; error: string }

export function useDispatchSidebarRead<T>(read: (signal: AbortSignal) => Promise<T>) {
  const [request, setRequest] = useState(0)
  const [completed, setCompleted] = useState<{
    read: typeof read
    request: number
    result: ReadResult<T>
  }>()
  useEffect(() => {
    const controller = new AbortController()
    const finish = (result: ReadResult<T>): void => {
      if (!controller.signal.aborted) {
        setCompleted({ read, request, result })
      }
    }
    void read(controller.signal).then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error: error instanceof Error ? error.message : String(error) })
    )
    return () => controller.abort()
  }, [read, request])
  return {
    result:
      completed?.read === read && completed.request === request ? completed.result : undefined,
    refresh: () => setRequest((previous) => previous + 1)
  }
}
