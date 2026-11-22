import { expect, it, vi } from 'vitest'
import { normalizeDecisionModelSettings } from '../../../../shared/settings/decision-model-settings'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './profile-state-maintenance-fixture'

export function registerDurableSettingsWriteTests(): void {
  it('waits for the SQLite write before returning or publishing the preference', async () => {
    const { store, authority, readState } = await createWorkerMaintenanceFixture()
    const started = maintenanceBarrier()
    const release = maintenanceBarrier()
    const write = authority.writeSerializedDomains.bind(authority)
    vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce(async (domains) => {
      started.resolve()
      await release.promise
      await write(domains)
    })
    const onChanged = vi.fn()
    store.onSettingsChanged(onChanged)
    let settled = false
    const pending = store.updateSettingsAndFlush(
      { alwaysForceDeleteWorktrees: true },
      { notifyListeners: true, originWebContentsId: 7 }
    )
    void pending.then(() => {
      settled = true
    })
    await started.promise
    expect(settled).toBe(false)
    expect(onChanged).not.toHaveBeenCalled()
    store.updateSettings({ theme: 'dark' })
    release.resolve()
    expect((await pending).theme).toBe('dark')
    expect(readState().settings.alwaysForceDeleteWorktrees).toBe(true)
    expect(onChanged).toHaveBeenCalledWith(
      { alwaysForceDeleteWorktrees: true },
      expect.objectContaining({ alwaysForceDeleteWorktrees: true }),
      7
    )
  })

  it('merges queued decision saves against the latest persisted state; legacy shapes collapse to the agent-only mode', async () => {
    const { store, readState } = await createWorkerMaintenanceFixture()
    function save(patch: { source: 'agent'; agent?: string }) {
      return store.updateSettingsAndFlush(() => ({
        decisionModel: normalizeDecisionModelSettings(patch)
      }))
    }

    await Promise.all([
      save({ source: 'agent', agent: 'codex' }),
      save({ source: 'agent', agent: 'claude' })
    ])

    expect(readState().settings.decisionModel).toEqual({
      source: 'agent',
      agent: 'claude'
    })
  })
}
