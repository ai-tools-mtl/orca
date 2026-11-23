import { useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RouteConfig } from './decision-config-values'

type TestResult = { ok: boolean; detail?: string; agent?: string }
type TestRequest = {
  method: 'orchestration.entryRoutingTest'
  params:
    | RouteConfig
    | {
        source: 'dedicated'
        baseUrl: string
        apiKey: string
        modelId: string
        protocol?: 'openai' | 'anthropic'
      }
}
type TestHost = { target: RuntimeClientTarget; label: string }
type RecordedResult = { host: string; version: string; result: TestResult }

export type DecisionConfigTest = ReturnType<typeof useDecisionConfigTest>

export function useDecisionConfigTest(draftVersion: string, savedVersion: string, host: TestHost) {
  const [results, setResults] = useState<RecordedResult[]>([])
  const [pending, setPending] = useState<{ version: string; host: string } | null>(null)
  const busy = useRef(false)
  const hostKey = host.target.kind === 'local' ? 'local' : `runtime:${host.target.environmentId}`
  const onHost = results.filter((entry) => entry.host === hostKey)

  function run(request: TestRequest): void {
    if (busy.current) {
      return
    }
    busy.current = true
    setPending({ version: draftVersion, host: host.label })
    const record = (value: TestResult): void => {
      setResults((previous) => [
        { host: hostKey, version: draftVersion, result: value },
        ...previous.filter(
          (entry) =>
            entry.host !== hostKey ||
            (entry.version !== draftVersion && entry.version === savedVersion)
        )
      ])
    }
    void callRuntimeRpc<TestResult>(host.target, request.method, request.params, {
      timeoutMs: 90_000
    })
      .then(record)
      .catch((error: unknown) =>
        record({ ok: false, detail: error instanceof Error ? error.message : String(error) })
      )
      .finally(() => {
        busy.current = false
        setPending(null)
      })
  }

  return {
    run,
    currentResult: onHost.find((entry) => entry.version === draftVersion)?.result,
    savedResult: onHost.find((entry) => entry.version === savedVersion)?.result,
    isTesting: pending !== null,
    isTestingCurrent: pending?.version === draftVersion,
    testingVersion:
      pending?.version === savedVersion
        ? 'saved'
        : pending?.version === draftVersion
          ? 'draft'
          : 'previous',
    testingHost: pending?.host,
    hostLabel: host.label
  }
}
