import { useId } from 'react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../../shared/agent-launch/catalog/tui-agent-display-names'
import {
  DECISION_ROUTING_AGENTS,
  isDecisionRoutingAgent
} from '../../../../../shared/settings/decision-routing-agents'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import type { RouteConfig } from './decision-config-values'

const AUTO = 'automatic'
function agentLabel(agent: string): string {
  return isTuiAgent(agent) ? TUI_AGENT_DISPLAY_NAMES[agent] : agent
}

/** The 任务路由方式 card: Agent 单次路由（统一动作协议 v1）+ 路由 Agent 选择——单卡，
 *  旧版类型分支（意图混合/自定义模型/结构化服务）已随旧链路移除。 */
export function TaskRoutingBlock({
  saved,
  draftAgent,
  selectedLocalHost,
  detectedAgents,
  onAgentChange,
  children
}: {
  saved: RouteConfig
  /** undefined = untouched (shows saved); null = explicit automatic selection. */
  draftAgent: string | null | undefined
  selectedLocalHost: boolean
  detectedAgents: readonly string[] | null
  onAgentChange: (agent: string | null) => void
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const fieldId = useId()
  const modeLabel = t(
    'auto.components.settings.TaskEntryPane.decisionModel.workerKindAgent',
    'Agent single-pass routing'
  )
  const auto = t(
    'auto.components.settings.TaskEntryPane.decisionModel.agentPlaceholder',
    'Automatic selection'
  )
  const agent = draftAgent === undefined ? saved.agent : (draftAgent ?? undefined)
  // 「当前生效」只反映已保存配置；草稿在下方控件里呈现。
  const active = [modeLabel, saved.agent ? agentLabel(saved.agent) : auto]
  const agentChoices = [
    ...new Set([
      ...(agent ? [agent] : []),
      ...(selectedLocalHost && detectedAgents
        ? detectedAgents.filter(isDecisionRoutingAgent)
        : DECISION_ROUTING_AGENTS)
    ])
  ]

  return (
    <SettingsGroup
      id="dispatch-decision-model"
      title={t(
        'auto.components.settings.TaskEntryPane.decisionModel.workerBlock',
        'Task routing method'
      )}
      description={t(
        'auto.components.settings.TaskEntryPane.decisionModel.routingHint',
        'Choose the task routing method used when automatic dispatch is enabled for a project; Agent single-pass routing is the default.'
      )}
    >
      <p data-settings-row="" className="py-3 text-xs break-words text-muted-foreground">
        {t(
          'auto.components.settings.TaskEntryPane.decisionModel.activeConfig',
          'In use: {{config}}',
          { config: active.filter(Boolean).join(' · ') }
        )}
      </p>
      <div data-settings-row="" className="flex flex-col gap-2.5 py-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${fieldId}-agent`}>
            {t('auto.components.settings.TaskEntryPane.decisionModel.agentLabel', 'Routing agent')}
          </Label>
          <Select
            value={agent ?? AUTO}
            onValueChange={(value) => onAgentChange(value === AUTO ? null : value)}
          >
            <SelectTrigger id={`${fieldId}-agent`} className="w-72 max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>{auto}</SelectItem>
              {agentChoices.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {agentLabel(candidate)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedLocalHost && agent ? (
            <p className="text-xs text-muted-foreground">
              {detectedAgents === null
                ? t(
                    'auto.components.settings.TaskEntryPane.decisionModel.detectingAgents',
                    'Detecting installed agents…'
                  )
                : detectedAgents.includes(agent)
                  ? t(
                      'auto.components.settings.TaskEntryPane.decisionModel.agentDetected',
                      'Detected on this machine'
                    )
                  : t(
                      'auto.components.settings.TaskEntryPane.decisionModel.agentUnavailable',
                      'This agent was not detected on this machine.'
                    )}
            </p>
          ) : null}
        </div>
      </div>
      {children}
    </SettingsGroup>
  )
}
