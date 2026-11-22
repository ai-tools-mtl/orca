// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const storeState = vi.hoisted(() => ({
  settingsSearchQuery: '',
  localDetectedAgentIdsByContext: { host: ['codex', 'claude', 'zcode'] } as Record<
    string,
    string[]
  >,
  ensureNativeDetectedAgents: vi.fn(async () => ['codex', 'claude'])
}))

vi.mock('../../../store/index', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
}))

// Why: Radix Select needs pointer/layout APIs happy-dom lacks; native controls keep values
// testable.
vi.mock('../../ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.currentTarget.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: (_props: { placeholder?: string }) => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

const callRuntimeRpc = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc }))

import DecisionModelSetting from './DecisionModelSetting'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import {
  normalizeDecisionModelSettings,
  type DecisionModelSettings
} from '../../../../../shared/settings/decision-model-settings'

/** What older builds may have persisted before the agent-only schema. */
type LegacyDecisionModelSettings = { source: string; agent?: string; splitAgent?: string }

function renderSettings(
  decisionModel: LegacyDecisionModelSettings | DecisionModelSettings | undefined
) {
  const initial = decisionModel
    ? ({ decisionModel } as Partial<GlobalSettings> as GlobalSettings)
    : ({} as GlobalSettings)
  const write = vi.fn<(patch: DecisionModelSettings) => Promise<void>>().mockResolvedValue()
  function Harness() {
    const [settings, setSettings] = useState(initial)
    return (
      <DecisionModelSetting
        settings={settings}
        forceVisible
        updateSettings={async ({ decisionModelPatch, routeBypassPatch }) => {
          if (decisionModelPatch !== undefined) {
            await write(decisionModelPatch)
            setSettings((current) => ({
              ...current,
              decisionModel: normalizeDecisionModelSettings(decisionModelPatch)
            }))
          }
          if (routeBypassPatch !== undefined) {
            setSettings((current) => ({ ...current, routeBypass: routeBypassPatch }))
          }
        }}
      />
    )
  }
  render(<Harness />)
  return write
}

function routingCard() {
  return within(screen.getByRole('heading', { name: 'Task routing method' }).closest('section')!)
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  storeState.ensureNativeDetectedAgents.mockResolvedValue(['codex', 'claude'])
  storeState.settingsSearchQuery = ''
})

describe('task entry routing method', () => {
  it('shows the unified agent router as the only mode and saves an agent selection', async () => {
    const write = renderSettings({ source: 'agent', agent: 'codex' })
    expect(routingCard().getByText(/In use: Agent single-pass routing · Codex/)).toBeDefined()
    fireEvent.change(routingCard().getAllByRole('combobox')[0]!, { target: { value: 'claude' } })
    fireEvent.click(routingCard().getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(write).toHaveBeenLastCalledWith({ source: 'agent', agent: 'claude' })
    )
    await waitFor(() =>
      expect(routingCard().getByText(/In use: Agent single-pass routing · Claude/)).toBeDefined()
    )
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('keeps the saved configuration active when a write fails and preserves the draft', async () => {
    const write = renderSettings({ source: 'agent', agent: 'codex' })
    write.mockRejectedValueOnce(new Error('disk full'))
    fireEvent.change(routingCard().getAllByRole('combobox')[0]!, { target: { value: 'claude' } })
    fireEvent.click(routingCard().getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(routingCard().getByRole('alert')).toBeDefined())
    expect(routingCard().getByText(/In use: Agent single-pass routing · Codex/)).toBeDefined()
    expect((routingCard().getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('claude')

    fireEvent.click(routingCard().getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(routingCard().getByText(/In use: Agent single-pass routing · Claude/)).toBeDefined()
    )
  })

  it('tests the saved routing configuration through its own probe', async () => {
    renderSettings({ source: 'agent', agent: 'codex' })
    callRuntimeRpc.mockResolvedValueOnce({ ok: true, agent: 'codex' })
    fireEvent.click(routingCard().getByRole('button', { name: 'Test routing' }))
    await waitFor(() => expect(routingCard().getByText(/Test passed · codex/)).toBeDefined())
    expect(callRuntimeRpc).toHaveBeenLastCalledWith(
      { kind: 'local' },
      'orchestration.entryRoutingTest',
      { source: 'agent', agent: 'codex' },
      expect.anything()
    )
  })

  it('normalizes legacy saved shapes onto the agent-only mode', () => {
    expect(normalizeDecisionModelSettings(undefined)).toBeUndefined()
    expect(
      normalizeDecisionModelSettings({
        source: 'intent_agent',
        splitAgent: 'claude'
      } as LegacyDecisionModelSettings)
    ).toEqual({ source: 'agent', agent: 'claude' })
    expect(normalizeDecisionModelSettings({ source: 'agent', agent: 'zcode' })).toEqual({
      source: 'agent',
      agent: 'zcode'
    })
  })
})
