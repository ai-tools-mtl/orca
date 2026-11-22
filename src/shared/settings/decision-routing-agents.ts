import { isTuiAgent } from '../agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import {
  isNamingOnlyTextAgent,
  listCommitMessageAgentIds
} from '../source-control/ai/generation/commit-message-agent-spec'

export const DECISION_ROUTING_AGENTS: ReadonlySet<TuiAgent> = new Set([
  ...listCommitMessageAgentIds().filter((agent) => !isNamingOnlyTextAgent(agent)),
  'zcode'
])

export function isDecisionRoutingAgent(agent: string): agent is TuiAgent {
  return isTuiAgent(agent) && DECISION_ROUTING_AGENTS.has(agent)
}
