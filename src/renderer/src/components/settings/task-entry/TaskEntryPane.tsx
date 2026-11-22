import DecisionModelSetting from './DecisionModelSetting'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type {
  DecisionModelSettings,
  RouteBypassSettings
} from '../../../../../shared/settings/decision-model-settings'
import { useTranslate } from '../../../i18n/use-translate'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'

type TaskEntryPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: {
    decisionModelPatch?: DecisionModelSettings
    routeBypassPatch?: RouteBypassSettings
  }) => Promise<void>
  updateGlobalSettings: (updates: Partial<GlobalSettings>) => Promise<unknown>
}

/** The 任务入口 pane body (plan §1/§9-A): the decision-model configuration plus the 专用
 *  模型旁路对照 toggle, and the dispatch workers' own auto-close switch (default off — a
 *  dispatched worker stays open; the global auto-close switch keeps governing other sources).
 *  The section chrome (title/description) is owned by the capability renderer's SettingsSection. */
export function TaskEntryPane({
  settings,
  updateSettings,
  updateGlobalSettings
}: TaskEntryPaneProps): React.JSX.Element {
  const t = useTranslate()
  const enabled = settings.entryWorkerAutoReleaseEnabled === true
  return (
    <>
      <DecisionModelSetting settings={settings} updateSettings={updateSettings} />
      <SettingsSwitchRow
        label={t(
          'auto.components.settings.TaskEntryPane.workerAutoReleaseTitle',
          'Auto-close dispatched workers'
        )}
        description={t(
          'auto.components.settings.TaskEntryPane.workerAutoReleaseDescription',
          "Closes a project-dispatch worker's chat 2 minutes after it finishes. Off by default, so dispatched workers stay open; their output stays reachable from the task card either way. If a worker starts again, the 2 minutes restart when it finishes."
        )}
        checked={enabled}
        ariaLabel={t(
          'auto.components.settings.TaskEntryPane.workerAutoReleaseTitle',
          'Auto-close dispatched workers'
        )}
        onChange={() => {
          void updateGlobalSettings({ entryWorkerAutoReleaseEnabled: !enabled })
        }}
      />
    </>
  )
}
