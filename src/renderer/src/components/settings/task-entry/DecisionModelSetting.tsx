import { useEffect, useId, useRef, useState } from 'react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { useAppStore } from '../../../store/index'
import { readNativeDetectedAgents } from '@/store/slices/agent-inventory/local-detected-agent-store-state'
import { matchesSettingsSearch } from '../search/settings-search'
import { getTaskEntryPaneSearchEntries } from './task-entry-search'
import { TaskRoutingBlock } from './TaskRoutingBlock'
import { RouteBypassBlock } from './RouteBypassBlock'
import { DecisionConfigFooter } from './DecisionConfigFooter'
import { useDecisionConfigTest } from './use-decision-config-test'
import { routeConfigOf, savedDecisionConfig } from './decision-config-values'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type {
  DecisionModelSettings,
  RouteBypassSettings
} from '../../../../../shared/settings/decision-model-settings'
import { normalizeRouteBypassSettings } from '../../../../../shared/settings/decision-model-settings'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

const LOCAL_HOST = 'local'

type DecisionModelSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: {
    decisionModelPatch?: DecisionModelSettings
    routeBypassPatch?: RouteBypassSettings
  }) => Promise<void>
  forceVisible?: boolean
}

export default function DecisionModelSetting({
  settings,
  updateSettings,
  forceVisible = false
}: DecisionModelSettingProps): React.JSX.Element | null {
  const t = useTranslate()
  const hostFieldId = useId()
  const query = useAppStore((state) => state.settingsSearchQuery)
  const detectedAgents = useAppStore(readNativeDetectedAgents)
  const environments = useAppStore((state) => state.runtimeEnvironments)
  const [testHostId, setTestHostId] = useState<string>()
  /** undefined = untouched (shows saved); null = explicit automatic selection. */
  const [agentEdit, setAgentEdit] = useState<string | null | undefined>()
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const savingRef = useRef(false)

  const saved = savedDecisionConfig(settings.decisionModel)
  const savedRoute = routeConfigOf(saved)
  const draftRoute = routeConfigOf({
    source: 'agent',
    ...(agentEdit === undefined ? savedRoute : agentEdit === null ? {} : { agent: agentEdit })
  })
  const dirty = JSON.stringify(draftRoute) !== JSON.stringify(savedRoute)

  const webClient = isWebClientLocation()
  const environment =
    environments?.find((entry) => `runtime:${entry.id}` === testHostId) ??
    (webClient
      ? (environments?.find((entry) => entry.id === settings.activeRuntimeEnvironmentId) ??
        environments?.[0])
      : undefined)
  const testHostUnavailable = webClient && !environment
  const target: RuntimeClientTarget = environment
    ? { kind: 'environment', environmentId: environment.id }
    : { kind: 'local' }
  const localLabel = t(
    'auto.components.settings.TaskEntryPane.decisionModel.localTestHost',
    'This machine'
  )
  const testHost = {
    target,
    label: testHostUnavailable
      ? t('auto.components.settings.TaskEntryPane.decisionModel.noTestHost', 'No test host')
      : (environment?.name ?? localLabel)
  }
  const routeVersion = JSON.stringify(draftRoute)
  const savedRouteVersion = JSON.stringify(savedRoute)
  const routeTest = useDecisionConfigTest(routeVersion, savedRouteVersion, testHost)

  useEffect(() => {
    if (!webClient) {
      void useAppStore.getState().ensureNativeDetectedAgents()
    }
  }, [webClient])

  async function save(): Promise<void> {
    if (savingRef.current) {
      return
    }
    savingRef.current = true
    setSaving(true)
    setSaveFailed(false)
    // 无 finally：react-compiler 拒绝带 finalizer 的 try 语句，两个分支各自复位。
    try {
      await updateSettings({ decisionModelPatch: draftRoute })
      setAgentEdit((edit) => (edit === agentEdit ? undefined : edit))
      savingRef.current = false
      setSaving(false)
    } catch {
      setSaveFailed(true)
      savingRef.current = false
      setSaving(false)
    }
  }

  if (!forceVisible && !dirty && !matchesSettingsSearch(query, getTaskEntryPaneSearchEntries(t))) {
    return null
  }
  const hostLabel = t('auto.components.settings.TaskEntryPane.decisionModel.testHost', 'Test host')

  return (
    <div className="space-y-6">
      {environments?.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={hostFieldId}>{hostLabel}</Label>
          <Select
            value={environment ? `runtime:${environment.id}` : LOCAL_HOST}
            onValueChange={setTestHostId}
          >
            <SelectTrigger id={hostFieldId} className="w-56 max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {!webClient ? <SelectItem value={LOCAL_HOST}>{localLabel}</SelectItem> : null}
              {environments.map((entry) => (
                <SelectItem key={entry.id} value={`runtime:${entry.id}`}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <TaskRoutingBlock
        saved={savedRoute}
        draftAgent={agentEdit}
        selectedLocalHost={!webClient && !environment}
        detectedAgents={detectedAgents}
        onAgentChange={setAgentEdit}
      >
        <DecisionConfigFooter
          dirty={dirty}
          defaultConfig={!settings.decisionModel}
          saving={saving}
          saveDisabled={Boolean(saving)}
          saveFailed={saveFailed}
          onSave={() => void save()}
          test={routeTest}
          testLabel={t(
            'auto.components.settings.TaskEntryPane.decisionModel.testRouting',
            'Test routing'
          )}
          testDisabled={testHostUnavailable}
          onTest={() =>
            routeTest.run({
              method: 'orchestration.entryRoutingTest',
              params: draftRoute
            })
          }
        />
      </TaskRoutingBlock>
      <RouteBypassBlock
        saved={normalizeRouteBypassSettings(settings.routeBypass)}
        updateSettings={updateSettings}
        forceVisible={forceVisible}
      />
    </div>
  )
}
