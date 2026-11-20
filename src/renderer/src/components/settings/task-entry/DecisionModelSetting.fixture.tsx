import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useAppStore } from '@/store/index'
import { ActiveSettingsSectionProvider } from '../section-layout/SettingsSection'
import { TaskEntryPane } from './TaskEntryPane'

function TaskEntryPreview(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  return settings ? (
    <ActiveSettingsSectionProvider value="task-entry">
      <TaskEntryPane settings={settings} updateSettings={updateSettings} />
    </ActiveSettingsSectionProvider>
  ) : null
}

export const desktop = defineFixture({ width: 820, render: () => <TaskEntryPreview /> })
