import DecisionModelSetting from './DecisionModelSetting'
import { matchesSettingsSearch } from '../search/settings-search'
import { getTaskEntryPaneSearchEntries } from './task-entry-search'
import { useAppStore } from '../../../store/index'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsSection } from '../section-layout/SettingsSection'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'

type TaskEntryPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

/** The 任务入口 settings section (plan §1/§9-A): the per-project entry's own configuration —
 *  which model its routing step (§5.1) uses to split requests. */
export function TaskEntryPane({ settings, updateSettings }: TaskEntryPaneProps): React.JSX.Element {
  const t = useTranslate()
  const query = useAppStore((state) => state.settingsSearchQuery)
  const title = t('auto.components.settings.TaskEntryPane.title', 'Task entry')
  return (
    <SettingsSection
      id="task-entry"
      title={title}
      description={t(
        'auto.components.settings.TaskEntryPane.description',
        'Configure the per-project entry that records, routes, and tracks requests.'
      )}
      searchEntries={getTaskEntryPaneSearchEntries(t)}
    >
      <DecisionModelSetting
        settings={settings}
        updateSettings={updateSettings}
        forceVisible={matchesSettingsSearch(query, [{ title }])}
      />
    </SettingsSection>
  )
}
