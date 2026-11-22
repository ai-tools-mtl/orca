import type { Repo } from '../../../shared/repository/repo-types'
import type { BranchNameWorkContext } from '../../../shared/source-control/ai/naming/branch-name-from-work'
import { resolveSourceControlActionRecipe } from '../../../shared/source-control/ai/source-control-ai-operation-policy'
import type { CommitMessageAgentEnvironmentResolvers } from '../../text-generation/execution/commit-message-agent-environment'
import {
  generateBranchNameFromContext,
  resolveCommitMessageSettings as resolveTextGenerationParams
} from '../../text-generation/commit-message-text-generation'
import type { GenerateBranchNameResult } from '../../text-generation/source-control-text-generation-types'
import { resolveGenerationTarget } from './first-work-generation-target'
import { generateNativeBranchSlug } from './first-work-native-naming'
import {
  resolveNamingAgentFallback,
  resolveSessionNamingAgent
} from './first-work-naming-agent-fallback'

export type FirstWorkBranchSlugGeneration =
  | { kind: 'generated'; slug: string }
  | {
      kind: 'generation-failed'
      generated: Extract<GenerateBranchNameResult, { success: false }>
    }
  /** Resolution named no usable agent; `error` is the publishable settings-diagnosis. */
  | { kind: 'no-agent'; error: string }
  /** The generation environment could not be prepared. */
  | { kind: 'no-target' }
  /** Factory-default binary missing and no other agent is installed. */
  | { kind: 'no-agent-installed' }

/**
 * Resolve, prepare and run branch-slug generation. Agent preference: an explicit settings pick,
 * then the agent that ran the first turn (installed by construction), then an installed-agent
 * probe when the factory-default binary is missing. Operation-specific error strings stay with
 * the callers.
 */
export async function generateFirstWorkBranchSlug(input: {
  cwd: string
  context: BranchNameWorkContext
  settings: Parameters<typeof resolveTextGenerationParams>[0]
  repo?: Pick<Repo, 'sourceControlAi'> | null
  hostKey?: string
  envResolvers: CommitMessageAgentEnvironmentResolvers | undefined
  /** The conversation's own agent (hook source / session provider), when known. */
  sessionAgentId?: string
}): Promise<FirstWorkBranchSlugGeneration> {
  let resolved = resolveTextGenerationParams(
    input.settings,
    input.hostKey,
    'branchName',
    input.repo
  )
  // Only the factory default defers to the conversation's agent; an explicit pick always wins.
  const sessionAgent = resolved.agentIsFactoryDefault
    ? resolveSessionNamingAgent(input.sessionAgentId, input.settings)
    : null
  if (sessionAgent) {
    // The conversation's own model first: specless providers (zcode) name through their
    // adapter's disposable text task, riding the network path that ran the turn.
    const recipe = resolveSourceControlActionRecipe({
      settings: input.settings,
      actionId: 'branchName'
    })
    if (!recipe.agentId && resolved.ok) {
      const slug = await generateNativeBranchSlug({
        agentId: sessionAgent,
        context: input.context,
        commandInputTemplate: recipe.commandInputTemplate,
        customPrompt: resolved.params.customPrompt ?? ''
      })
      if (slug) {
        return { kind: 'generated', slug }
      }
    }
    const sessionResolved = resolveTextGenerationParams(
      { ...input.settings, defaultTuiAgent: sessionAgent },
      input.hostKey,
      'branchName',
      input.repo
    )
    // An unqualified session agent (no naming spec, naming-only) keeps the original resolution.
    if (sessionResolved.ok) {
      resolved = sessionResolved
    }
  }
  if (!resolved.ok) {
    return { kind: 'no-agent', error: resolved.error }
  }
  // The session rewrite keeps the choice automatic: neither factory default nor user-explicit.
  const namingAgentIsAutomatic = resolved.agentIsFactoryDefault || sessionAgent !== null
  const resolveTarget = (agentId: string) =>
    resolveGenerationTarget(input.cwd, agentId, { getAgentEnvResolvers: () => input.envResolvers })

  const target = await resolveTarget(resolved.params.agentId)
  if (!target) {
    return { kind: 'no-target' }
  }
  let generated = await generateBranchNameFromContext(input.context, resolved.params, target)
  if (!generated.success) {
    const fallback = await resolveNamingAgentFallback({
      failedErrorCode: generated.errorCode,
      params: resolved.params,
      agentChoiceIsAutomatic: namingAgentIsAutomatic,
      cwd: input.cwd,
      settings: input.settings
    })
    if (fallback.kind === 'none-installed') {
      return { kind: 'no-agent-installed' }
    }
    if (fallback.kind === 'fallback') {
      const fallbackTarget = await resolveTarget(fallback.params.agentId)
      if (fallbackTarget) {
        generated = await generateBranchNameFromContext(
          input.context,
          fallback.params,
          fallbackTarget
        )
      }
    }
  }
  if (!generated.success) {
    return { kind: 'generation-failed', generated }
  }
  return { kind: 'generated', slug: generated.slug }
}
