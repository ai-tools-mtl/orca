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

type EndpointDraft = Pick<RouteBypassSettings, 'baseUrl' | 'apiKey' | 'modelId'>

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
  const [draft, setDraft] = useState<RouteBypassSettings>(saved)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const savingRef = useRef(false)
  const savedVersion = JSON.stringify(normalizeRouteBypassSettings(saved))
  const draftVersion = JSON.stringify(normalizeRouteBypassSettings(draft))
  const dirty = draftVersion !== savedVersion
  const test = useDecisionConfigTest(draftVersion, savedVersion, {
    target: { kind: 'local' },
    label: t(
      'auto.components.settings.TaskEntryPane.routeBypass.testHost',
      'This machine (shadow host)'
    )
  })

  const validation =
    draft.enabled && (!draft.baseUrl?.trim() || !draft.apiKey?.trim() || !draft.modelId?.trim())
      ? t(
          'auto.components.settings.TaskEntryPane.routeBypass.configMissing',
          'Endpoint base URL, API key and model are required while the shadow run is enabled.'
        )
      : draft.baseUrl?.trim() && !isDecisionServiceUrl(draft.baseUrl)
        ? t(
            'auto.components.settings.TaskEntryPane.routeBypass.invalidUrl',
            'Enter an HTTP or HTTPS endpoint URL without credentials, a query, or a fragment.'
          )
        : undefined

  async function save(): Promise<void> {
    if (savingRef.current) {
      return
    }
    savingRef.current = true
    setSaving(true)
    setSaveFailed(false)
    try {
      const next = normalizeRouteBypassSettings(draft)
      await updateSettings({ routeBypassPatch: next })
      setDraft(next)
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

  const endpoint: EndpointDraft = {
    baseUrl: draft.baseUrl,
    apiKey: draft.apiKey,
    modelId: draft.modelId
  }
  const changeEndpoint = (patch: Partial<EndpointDraft>): void =>
    setDraft((current) => ({ ...current, ...patch }))

  return (
    <div data-settings-group="route-bypass" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`${fieldId}-enabled`}>
          {t(
            'auto.components.settings.TaskEntryPane.routeBypass.title',
            'Dedicated decision model (shadow evaluation)'
          )}
        </Label>
        <Switch
          id={`${fieldId}-enabled`}
          checked={draft.enabled}
          onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
        />
      </div>
      <p className="text-xs break-words text-muted-foreground">
        {t(
          'auto.components.settings.TaskEntryPane.routeBypass.hint',
          'Shadow-runs this endpoint against the same submissions as the accepted Agent Router for comparison reports. Actual routing is unchanged.'
        )}
      </p>
      {draft.enabled ? (
        <div className="flex flex-col gap-2.5 py-1">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${fieldId}-baseUrl`}>
              {t('auto.components.settings.TaskEntryPane.routeBypass.baseUrl', 'Endpoint base URL')}
            </Label>
            <Input
              id={`${fieldId}-baseUrl`}
              value={endpoint.baseUrl ?? ''}
              onChange={(event) => changeEndpoint({ baseUrl: event.target.value })}
              placeholder={t(
                'auto.components.settings.TaskEntryPane.routeBypass.baseUrlPlaceholder',
                'https://dedicated.example/v1'
              )}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${fieldId}-apiKey`}>
              {t('auto.components.settings.TaskEntryPane.routeBypass.apiKey', 'API key')}
            </Label>
            <Input
              id={`${fieldId}-apiKey`}
              type="password"
              value={endpoint.apiKey ?? ''}
              onChange={(event) => changeEndpoint({ apiKey: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${fieldId}-modelId`}>
              {t('auto.components.settings.TaskEntryPane.routeBypass.modelId', 'Model')}
            </Label>
            <Input
              id={`${fieldId}-modelId`}
              value={endpoint.modelId ?? ''}
              onChange={(event) => changeEndpoint({ modelId: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${fieldId}-protocol`}>
              {t('auto.components.settings.TaskEntryPane.routeBypass.protocol', 'Protocol')}
            </Label>
            <Select
              value={draft.protocol ?? 'openai'}
              onValueChange={(protocol) => {
                if (protocol === 'openai' || protocol === 'anthropic') {
                  setDraft((current) => ({ ...current, protocol }))
                }
              }}
            >
              <SelectTrigger id={`${fieldId}-protocol`} className="w-72 max-w-full">
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
        </div>
      ) : null}
      <DecisionConfigFooter
        dirty={dirty}
        defaultConfig={
          savedVersion === JSON.stringify(normalizeRouteBypassSettings({ enabled: false }))
        }
        saving={saving}
        saveDisabled={Boolean(saving || validation)}
        saveFailed={saveFailed}
        validation={validation}
        onSave={() => void save()}
        test={test}
        testLabel={t('auto.components.settings.TaskEntryPane.routeBypass.test', 'Test endpoint')}
        testDisabled={Boolean(validation)}
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
    </div>
  )
}
