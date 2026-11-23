import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useAppStore } from '@/store/index'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { ActiveSettingsSectionProvider } from '../section-layout/SettingsSection'
import { TaskEntryPane } from './TaskEntryPane'

function TaskEntryPreview(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettingsOrThrow)
  return settings ? (
    <ActiveSettingsSectionProvider value="task-entry">
      <TaskEntryPane
        settings={settings}
        updateSettings={updateSettings}
        updateGlobalSettings={updateSettings}
      />
    </ActiveSettingsSectionProvider>
  ) : null
}

export const desktop = defineFixture({ width: 820, render: () => <TaskEntryPreview /> })

const configured: GlobalSettings = {
  ...getDefaultSettings('/fixture'),
  decisionModel: {
    source: 'agent',
    agent: 'codex'
  }
}

export const shadowEvaluation = defineFixture({
  width: 760,
  render: () => (
    <div className="settings-view-shell bg-background p-5">
      <TaskEntryPreview />
    </div>
  ),
  store: { settings: configured, localDetectedAgentIdsByContext: { host: ['codex'] } },
  setup: () => {
    let persisted = configured
    window.api.settings.set = async ({ routeBypassPatch, decisionModelPatch, ...updates }) => {
      persisted = {
        ...persisted,
        ...updates,
        ...(routeBypassPatch ? { routeBypass: routeBypassPatch } : {}),
        ...(decisionModelPatch ? { decisionModel: decisionModelPatch } : {})
      }
      return persisted
    }
    window.api.runtime.call = async ({ method }) => ({
      id: 'fixture',
      ok: true,
      _meta: { runtimeId: 'fixture' },
      result: method === 'orchestration.entryRoutingTest' ? { ok: true } : []
    })
  }
})

export const configuredChinese = defineFixture({
  width: 720,
  store: { settings: configured, localDetectedAgentIdsByContext: { host: ['codex', 'claude'] } },
  render: () => <TaskEntryPreview />,
  setup: () => {
    Object.assign(window.api, {
      runtime: {
        ...window.api.runtime,
        call: async ({ method }: { method: string }) => ({
          id: 'fixture',
          ok: true,
          result: method === 'orchestration.entryRoutingTest' ? { ok: true, agent: 'codex' } : []
        })
      }
    })
  },
  interact: async (frame) => {
    await setRendererUiLanguage('zh')
    await new Promise(requestAnimationFrame)
    for (const button of frame.querySelectorAll('button')) {
      if (button.textContent?.trim() === '测试路由') {
        button.click()
      }
    }
  }
})
