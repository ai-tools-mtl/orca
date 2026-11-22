import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import type { EntryRoutingTestParams } from '../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { detectAgentsOnHost } from '../../../../preflight/workspace-agent-detection'
import { createAgentRouteProposalProvider } from '../../../orchestration/routing/agent-route-proposal-provider'
import { createDedicatedRouteProposalProvider } from '../../../orchestration/routing/dedicated-route-proposal-provider'
import type { RoutingDecisionContext } from '../../../orchestration/routing/routing-router'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { resolveEntryRoutingAgent } from './entry-unified-route'

type EntryRoutingTestResult = { ok: boolean; detail?: string; agent?: TuiAgent }

/** The unified v1 action protocol (Agent 单次路由): a healthy router answers a clear work
 *  sample with at least one deliverable action or a concrete question — a bare no_action is
 *  a broken routing agent. */
function assertSampleRouteProposal(proposal: { actions: { type: string }[] }): void {
  if (
    !proposal.actions.some((action) => action.type === 'create_task' || action.type === 'clarify')
  ) {
    throw new Error('The router did not return a work action for the sample.')
  }
}

export async function testEntryRouting(
  params: z.infer<typeof EntryRoutingTestParams>,
  runtime: OrcaRuntimeService
): Promise<EntryRoutingTestResult> {
  const sample: RoutingDecisionContext = {
    inputId: `test-${randomUUID()}`,
    text: '检查登录表单的错误提示是否清楚，并独立核查帮助页上的链接是否有效。',
    candidateTasks: [],
    executorCapabilities: []
  }
  if (params.source === 'dedicated') {
    // 专用决策模型端点探针：同一动作协议样例，结构门与 Agent 分支一致。
    try {
      const provider = createDedicatedRouteProposalProvider({
        apiKey: params.apiKey,
        baseUrl: params.baseUrl,
        modelId: params.modelId,
        protocol: params.protocol
      })
      assertSampleRouteProposal(await provider(sample))
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, detail: message.slice(0, 300) }
    }
  }
  try {
    const settings = runtime.requireStore().getSettings()
    const installed = await detectAgentsOnHost(
      { kind: 'local' },
      {
        disabledTuiAgents: settings.disabledTuiAgents,
        agentCmdOverrides: settings.agentCmdOverrides
      }
    )
    const agent = resolveEntryRoutingAgent(params.agent, installed)
    if (!agent || !installed.includes(agent)) {
      return {
        ok: false,
        detail: 'The selected routing agent was not detected on the test host.',
        agent
      }
    }
    const provider = createAgentRouteProposalProvider({
      agent,
      cwd: settings.workspaceDir || process.cwd(),
      ensureStructuredHost: () => runtime.ensureStructuredAgentSessionHost(),
      agentCommandOverride: settings.agentCmdOverrides?.[agent]?.trim()
    })
    assertSampleRouteProposal(await provider({ ...sample, executorCapabilities: installed }))
    return { ok: true, agent }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, detail: message.slice(0, 300) }
  }
}
