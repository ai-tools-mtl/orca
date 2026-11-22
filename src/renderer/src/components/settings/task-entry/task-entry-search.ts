import type { Translate } from '@/i18n/use-translate'

export function getTaskEntryPaneSearchEntries(t: Translate): { title: string }[] {
  return [
    {
      title: t(
        'auto.components.settings.TaskEntryPane.decisionModel.workerBlock',
        'Task routing method'
      )
    }
  ]
}
