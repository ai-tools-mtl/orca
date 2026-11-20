import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '../../../store/index'
import { matchesSettingsSearch } from '../search/settings-search'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import type { DecisionModelSettings } from '../../../../../shared/settings/decision-model-settings'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'

type DecisionModelSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  forceVisible?: boolean
}

const DEFAULT_CONFIG: DecisionModelSettings = { source: 'zcode-plan' }

/** The 任务入口's 决策模型 (plan §5.1): which model proposes sub-actions for auto-routing —
 *  the user's ZCode coding plan credential, a connected agent, or any OpenAI-compatible
 *  provider. */
export default function DecisionModelSetting({
  settings,
  updateSettings,
  forceVisible = false
}: DecisionModelSettingProps): React.JSX.Element | null {
  const t = useTranslate()
  const query = useAppStore((state) => state.settingsSearchQuery)
  const title = t(
    'auto.components.settings.TaskEntryPane.decisionModel.title',
    'Task entry · decision model'
  )
  const [draft, setDraft] = useState<DecisionModelSettings>(
    settings.decisionModel ?? DEFAULT_CONFIG
  )
  const custom = draft.source === 'custom'
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.decisionModel ?? DEFAULT_CONFIG)

  const save = (): void => {
    void updateSettings({ decisionModel: draft })
  }

  const visible = forceVisible || dirty || matchesSettingsSearch(query, [{ title }])
  if (!visible) {
    return null
  }
  return (
    <SettingsGroup id="dispatch-decision-model" title={title}>
      <div className="flex flex-col gap-2.5 py-4 text-sm">
        <p className="text-muted-foreground text-xs">
          {t(
            'auto.components.settings.TaskEntryPane.decisionModel.description',
            'The model the task entry uses to split requests into sub-actions for auto-routing.'
          )}
        </p>
        <div className="flex flex-col gap-1">
          <Label>
            {t('auto.components.settings.TaskEntryPane.decisionModel.provider', 'Source')}
          </Label>
          <Select
            value={draft.source}
            onValueChange={(source) => {
              if (source !== 'zcode-plan' && source !== 'agent' && source !== 'custom') {
                return
              }
              setDraft((current) => ({
                ...(source === 'custom'
                  ? {
                      baseUrl: current.baseUrl ?? '',
                      apiKey: current.apiKey ?? '',
                      modelId: current.modelId ?? ''
                    }
                  : source === 'agent'
                    ? { agent: current.agent ?? 'codex' }
                    : {}),
                source
              }))
            }}
          >
            <SelectTrigger className="w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zcode-plan">
                {t(
                  'auto.components.settings.TaskEntryPane.decisionModel.providerZcodePlan',
                  'ZCode coding plan credential (its own model selection)'
                )}
              </SelectItem>
              <SelectItem value="agent">
                {t(
                  'auto.components.settings.TaskEntryPane.decisionModel.providerAgent',
                  'A connected agent (one-shot split call)'
                )}
              </SelectItem>
              <SelectItem value="custom">
                {t(
                  'auto.components.settings.TaskEntryPane.decisionModel.providerCustom',
                  'Custom OpenAI-compatible provider'
                )}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {draft.source === 'agent' ? (
          <div className="flex flex-col gap-1">
            <Label>
              {t('auto.components.settings.TaskEntryPane.decisionModel.agentLabel', 'Agent')}
            </Label>
            <Select
              value={draft.agent ?? 'codex'}
              onValueChange={(agent) => setDraft((current) => ({ ...current, agent }))}
            >
              <SelectTrigger className="w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['codex', 'claude', 'gemini', 'copilot'].map((agent) => (
                  <SelectItem key={agent} value={agent}>
                    {agent}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {custom ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <Label>
                {t('auto.components.settings.TaskEntryPane.decisionModel.baseUrl', 'Base URL')}
              </Label>
              <Input
                value={draft.baseUrl ?? ''}
                placeholder={t(
                  'auto.components.settings.TaskEntryPane.decisionModel.baseUrlPlaceholder',
                  'https://api.example.com/v1'
                )}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, baseUrl: event.target.value }))
                }
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label>
                {t('auto.components.settings.TaskEntryPane.decisionModel.apiKey', 'API key')}
              </Label>
              <Input
                type="password"
                value={draft.apiKey ?? ''}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, apiKey: event.target.value }))
                }
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label>
                {t('auto.components.settings.TaskEntryPane.decisionModel.modelId', 'Model')}
              </Label>
              <Input
                value={draft.modelId ?? ''}
                placeholder={t(
                  'auto.components.settings.TaskEntryPane.decisionModel.modelIdPlaceholder',
                  'gpt-4o-mini / deepseek-chat / …'
                )}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, modelId: event.target.value }))
                }
              />
            </div>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!dirty} onClick={save}>
            {t('auto.components.settings.TaskEntryPane.decisionModel.save', 'Save')}
          </Button>
          {dirty ? (
            <span className="text-muted-foreground text-xs">
              {t('auto.components.settings.TaskEntryPane.decisionModel.unsaved', 'Unsaved changes')}
            </span>
          ) : null}
        </div>
      </div>
    </SettingsGroup>
  )
}
