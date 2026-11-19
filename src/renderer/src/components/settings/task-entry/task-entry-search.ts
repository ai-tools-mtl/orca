import type { Translate } from '@/i18n/use-translate'

/** Search entries for the 任务入口 settings section. */
export function getTaskEntryPaneSearchEntries(t: Translate): { title: string }[] {
  return [
    {
      title: t(
        'auto.components.settings.TaskEntryPane.decisionModel.title',
        'Task entry · decision model'
      )
    },
    {
      title: t(
        'auto.components.settings.TaskEntryPane.decisionModel.description',
        'The model the task entry uses to split requests into sub-actions for auto-routing.'
      )
    }
  ]
}
