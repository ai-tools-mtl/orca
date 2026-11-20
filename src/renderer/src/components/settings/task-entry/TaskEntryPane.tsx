import DecisionModelSetting from './DecisionModelSetting'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'

type TaskEntryPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

/** The 任务入口 pane body (plan §1/§9-A): the decision-model configuration. The section
 *  chrome (title/description) is owned by the capability renderer's SettingsSection. */
export function TaskEntryPane({ settings, updateSettings }: TaskEntryPaneProps): React.JSX.Element {
  return <DecisionModelSetting settings={settings} updateSettings={updateSettings} />
}
