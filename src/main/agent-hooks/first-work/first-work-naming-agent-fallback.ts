import { wslDistroForCommand } from '../../../shared/file-access/wsl-paths'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../shared/agent-launch/catalog/tui-agent-config'
import { isTuiAgentEnabled } from '../../../shared/agent-launch/catalog/tui-agent-selection'
import {
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  listCommitMessageAgentCapabilities
} from '../../../shared/source-control/ai/generation/commit-message-agent-spec'
import type { ResolvedSourceControlAiGenerationParams } from '../../../shared/source-control/ai/source-control-ai-operation-resolution'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { detectInstalledAgentsWithShellPathHydration } from '../../preflight/installed-agent-detection'

export type NamingAgentFallback =
  | { kind: 'fallback'; params: ResolvedSourceControlAiGenerationParams }
  /** No installed naming agent at all: keep the creature name quietly. */
  | { kind: 'none-installed' }
  /** Explicit configuration or another failure: surface the original result. */
  | { kind: 'keep-failure' }

/** The resolved naming agent could not run at all; another installed agent may still name. */
const UNUSABLE_NAMING_AGENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'agentBinaryNotFound',
  'agentCouldNotStart',
  'agentFailedToStart',
  'cliFailed',
  'cliFailedWithDetail'
])

type FallbackSettings = Partial<Pick<GlobalSettings, 'disabledTuiAgents' | 'agentCmdOverrides'>>

// Shell-path hydration spawns a login shell; background renames must not re-probe per worktree.
const DETECTED_NAMING_AGENTS_TTL_MS = 5 * 60_000

let detectedNamingAgents: { at: number; agentIds: string[] } | null = null
let detectionInFlight: Promise<string[] | null> | null = null

/** Null means the probe itself failed; callers keep the original failure retryable. */
function detectInstalledNamingAgents(settings: FallbackSettings): Promise<string[] | null> {
  const cached = detectedNamingAgents
  if (cached && Date.now() - cached.at < DETECTED_NAMING_AGENTS_TTL_MS) {
    return Promise.resolve(cached.agentIds)
  }
  detectionInFlight ??= detectInstalledAgentsWithShellPathHydration(undefined, {
    disabledTuiAgents: settings.disabledTuiAgents,
    agentCmdOverrides: settings.agentCmdOverrides
  }).then(
    (agentIds) => {
      detectedNamingAgents = { at: Date.now(), agentIds }
      return agentIds
    },
    (error: unknown) => {
      console.warn('[auto-branch-rename] installed-agent detection failed:', error)
      return null
    }
  )
  const inFlight = detectionInFlight
  void inFlight.finally(() => {
    if (detectionInFlight === inFlight) {
      detectionInFlight = null
    }
  })
  return inFlight
}

function resolveFallbackAgentId(
  failedAgentId: string,
  settings: FallbackSettings,
  detected: readonly string[]
): TuiAgent | null {
  const disabled = new Set(settings.disabledTuiAgents ?? [])
  return (
    listCommitMessageAgentCapabilities('branchName')
      .map((capability) => capability.id)
      .find((id) => id !== failedAgentId && !disabled.has(id) && detected.includes(id)) ?? null
  )
}

/** Swap the agent identity onto the resolved recipe; prompts and templates are agent-agnostic. */
function fallbackGenerationParams(
  base: ResolvedSourceControlAiGenerationParams,
  agentId: TuiAgent,
  settings: FallbackSettings
): ResolvedSourceControlAiGenerationParams | null {
  const spec = getCommitMessageAgentSpec(agentId)
  const model = spec ? getCommitMessageModel(agentId, spec.defaultModelId) : undefined
  if (!spec || !model) {
    return null
  }
  const agentCommandOverride = settings.agentCmdOverrides?.[agentId]?.trim()
  return {
    ...base,
    agentId,
    model: model.id,
    thinkingLevel: undefined,
    customAgentCommand: undefined,
    ...(agentCommandOverride ? { agentCommandOverride } : {})
  }
}

/**
 * The agent that ran the first turn is installed by construction, so it beats the factory default.
 * Spec and naming-capability validation stays with resolution; an unqualified id keeps the default.
 */
export function resolveSessionNamingAgent(
  sessionAgentId: string | undefined,
  settings: FallbackSettings
): TuiAgent | null {
  if (!sessionAgentId || !isTuiAgent(sessionAgentId)) {
    return null
  }
  return isTuiAgentEnabled(sessionAgentId, settings.disabledTuiAgents) ? sessionAgentId : null
}

export async function resolveNamingAgentFallback(input: {
  failedErrorCode: string | undefined
  params: ResolvedSourceControlAiGenerationParams
  agentChoiceIsAutomatic: boolean
  cwd: string
  settings: FallbackSettings
}): Promise<NamingAgentFallback> {
  if (
    !UNUSABLE_NAMING_AGENT_ERROR_CODES.has(input.failedErrorCode ?? '') ||
    !input.agentChoiceIsAutomatic ||
    // WSL guests need their own probe; keep the existing failure flow there.
    wslDistroForCommand(input.cwd)
  ) {
    return { kind: 'keep-failure' }
  }
  const detected = await detectInstalledNamingAgents(input.settings)
  if (!detected) {
    return { kind: 'keep-failure' }
  }
  const agentId = resolveFallbackAgentId(input.params.agentId, input.settings, detected)
  if (!agentId) {
    return { kind: 'none-installed' }
  }
  const params = fallbackGenerationParams(input.params, agentId, input.settings)
  return params ? { kind: 'fallback', params } : { kind: 'none-installed' }
}
