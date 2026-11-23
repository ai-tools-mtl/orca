import { useId, useRef, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '../../../store/index'
import { matchesSettingsSearch } from '../search/settings-search'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { getTaskEntryPaneSearchEntries } from './task-entry-search'
import { DecisionConfigFooter } from './DecisionConfigFooter'
import { useDecisionConfigTest } from './use-decision-config-test'
import { normalizeRouteBypassSettings } from '../../../../../shared/settings/decision-model-settings'
import type { RouteBypassSettings } from '../../../../../shared/settings/decision-model-settings'

/** Same URL policy the decision endpoints use: http/https, no credentials, query or fragment. */
function isDecisionServiceUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search
    )
  } catch {
    return false
  }
}

type EndpointDraft = Pick<RouteBypassSettings, 'baseUrl' | 'apiKey' | 'modelId' | 'protocol'>

/** 专用决策模型旁路对照（评估）配置块：开关 + 端点三件套 + 连接测试。评估期的旁路调用
 *  只进对照报告——实际路由不受影响（entry-intent-routing-design §专用决策模型旁路验收）。 */
export function RouteBypassBlock({
  saved,
  updateSettings,
  forceVisible = false
}: {
  saved: RouteBypassSettings
  updateSettings: (updates: { routeBypassPatch: RouteBypassSettings }) => Promise<void>
  forceVisible?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const fieldId = useId()
  const query = useAppStore((state) => state.settingsSearchQuery)
  const [draftEdit, setDraftEdit] = useState<RouteBypassSettings>()
  const draft = draftEdit ?? saved
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [testRevision, setTestRevision] = useState(0)
  const savingRef = useRef(false)
  const savedVersion = JSON.stringify(normalizeRouteBypassSettings(saved))
  const draftVersion = JSON.stringify(normalizeRouteBypassSettings(draft))
  const dirty = draftVersion !== savedVersion
  const test = useDecisionConfigTest(
    `${testRevision}:${draftVersion}`,
    `${testRevision}:${savedVersion}`,
    {
      target: { kind: 'local' },
      label: t(
        'auto.components.settings.TaskEntryPane.routeBypass.testHost',
        'This machine (shadow host)'
      )
    }
  )

  const invalidUrl = Boolean(draft.baseUrl?.trim() && !isDecisionServiceUrl(draft.baseUrl))
  const validation =
    draft.enabled && (!draft.baseUrl?.trim() || !draft.apiKey?.trim() || !draft.modelId?.trim())
      ? t(
          'auto.components.settings.TaskEntryPane.routeBypass.configMissing',
          'Endpoint base URL, API key and model are required while the shadow run is enabled.'
        )
      : invalidUrl
        ? t(
            'auto.components.settings.TaskEntryPane.routeBypass.invalidUrl',
            'Enter an HTTP or HTTPS endpoint URL without credentials, a query, or a fragment.'
          )
        : undefined

  async function save(value: RouteBypassSettings, disabling = false): Promise<void> {
    if (savingRef.current) {
      return
    }
    savingRef.current = true
    setSaving(true)
    setSaveFailed(false)
    try {
      const next = normalizeRouteBypassSettings(value)
      await updateSettings({ routeBypassPatch: next })
      setDraftEdit((current) => (disabling && current ? { ...current, enabled: false } : undefined))
      if (disabling) {
        setTestRevision((revision) => revision + 1)
      }
    } catch {
      setSaveFailed(true)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  if (
    !forceVisible &&
    !dirty &&
    !matchesSettingsSearch(query, [
      ...getTaskEntryPaneSearchEntries(t),
      {
        title: t(
          'auto.components.settings.TaskEntryPane.routeBypass.title',
          'Dedicated decision model (shadow evaluation)'
        )
      }
    ])
  ) {
    return null
  }

  const changeEndpoint = (patch: Partial<EndpointDraft>): void => {
    setDraftEdit((current) => ({ ...(current ?? saved), ...patch }))
    setSaveFailed(false)
    setTestRevision((revision) => revision + 1)
  }

  function changeEnabled(enabled: boolean): void {
    if (!enabled && saved.enabled) {
      void save({ ...saved, enabled: false }, true)
      return
    }
    setDraftEdit((current) => ({ ...(current ?? saved), enabled }))
    setSaveFailed(false)
    setTestRevision((revision) => revision + 1)
  }

  return (
    <SettingsGroup>
      <SettingsRow
        labelId={`${fieldId}-enabled-label`}
        label={t(
          'auto.components.settings.TaskEntryPane.routeBypass.title',
          'Dedicated decision model (shadow evaluation)'
        )}
        description={t(
          'auto.components.settings.TaskEntryPane.routeBypass.hint',
          'Runs the same requests through a dedicated model for comparison reports. The Agent Router still assigns tasks.'
        )}
        control={
          <Switch
            aria-labelledby={`${fieldId}-enabled-label`}
            checked={draft.enabled}
            onCheckedChange={changeEnabled}
            disabled={saving}
          />
        }
      />
      {draft.enabled ? (
        <>
          <fieldset data-settings-row="" disabled={saving} className="@container min-w-0 py-3">
            <div className="grid grid-cols-1 gap-3 @md:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1 @md:col-span-2">
                <Label htmlFor={`${fieldId}-baseUrl`}>
                  {t(
                    'auto.components.settings.TaskEntryPane.routeBypass.baseUrl',
                    'Endpoint base URL'
                  )}
                </Label>
                <Input
                  id={`${fieldId}-baseUrl`}
                  value={draft.baseUrl ?? ''}
                  aria-invalid={invalidUrl}
                  onChange={(event) => changeEndpoint({ baseUrl: event.target.value })}
                  placeholder={t(
                    'auto.components.settings.TaskEntryPane.routeBypass.baseUrlPlaceholder',
                    'https://dedicated.example/v1'
                  )}
                />
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <Label htmlFor={`${fieldId}-protocol`}>
                  {t('auto.components.settings.TaskEntryPane.routeBypass.protocol', 'Protocol')}
                </Label>
                <Select
                  value={draft.protocol ?? 'openai'}
                  disabled={saving}
                  onValueChange={(protocol) => {
                    if (protocol === 'openai' || protocol === 'anthropic') {
                      changeEndpoint({ protocol })
                    }
                  }}
                >
                  <SelectTrigger id={`${fieldId}-protocol`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">
                      {t(
                        'auto.components.settings.TaskEntryPane.routeBypass.protocolOpenAI',
                        'OpenAI-compatible (chat completions)'
                      )}
                    </SelectItem>
                    <SelectItem value="anthropic">
                      {t(
                        'auto.components.settings.TaskEntryPane.routeBypass.protocolAnthropic',
                        'Anthropic-compatible (messages)'
                      )}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <Label htmlFor={`${fieldId}-modelId`}>
                  {t('auto.components.settings.TaskEntryPane.routeBypass.modelId', 'Model')}
                </Label>
                <Input
                  id={`${fieldId}-modelId`}
                  value={draft.modelId ?? ''}
                  onChange={(event) => changeEndpoint({ modelId: event.target.value })}
                />
              </div>
              <div className="flex min-w-0 flex-col gap-1 @md:col-span-2">
                <Label htmlFor={`${fieldId}-apiKey`}>
                  {t('auto.components.settings.TaskEntryPane.routeBypass.apiKey', 'API key')}
                </Label>
                <Input
                  id={`${fieldId}-apiKey`}
                  type="password"
                  value={draft.apiKey ?? ''}
                  onChange={(event) => changeEndpoint({ apiKey: event.target.value })}
                />
              </div>
            </div>
          </fieldset>
          <DecisionConfigFooter
            compact
            dirty={dirty}
            defaultConfig={
              savedVersion === JSON.stringify(normalizeRouteBypassSettings({ enabled: false }))
            }
            saving={saving}
            saveDisabled={Boolean(saving || validation)}
            saveFailed={saveFailed}
            validation={validation}
            onSave={() => void save(draft)}
            test={test}
            testLabel={t(
              'auto.components.settings.TaskEntryPane.routeBypass.test',
              'Test endpoint'
            )}
            testDisabled={Boolean(validation || saving)}
            onTest={() => {
              if (draft.baseUrl?.trim() && draft.apiKey?.trim() && draft.modelId?.trim()) {
                test.run({
                  method: 'orchestration.entryRoutingTest',
                  params: {
                    source: 'dedicated',
                    baseUrl: draft.baseUrl.trim(),
                    apiKey: draft.apiKey.trim(),
                    modelId: draft.modelId.trim(),
                    ...(draft.protocol ? { protocol: draft.protocol } : {})
                  }
                })
              }
            }}
          />
        </>
      ) : null}
    </SettingsGroup>
  )
}
