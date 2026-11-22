import {
  buildBranchNamePrompt,
  sanitizeBranchSlug,
  type BranchNameWorkContext
} from '../../../shared/source-control/ai/naming/branch-name-from-work'
import { renderSourceControlActionCommandTemplate } from '../../../shared/source-control/ai/recipes/source-control-ai-actions'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** Providers whose structured adapter carries a native disposable text task (chat naming's set). */
const NATIVE_NAMING_AGENTS = new Set(['zcode'])

export function isNativeNamingAgent(agentId: string): boolean {
  return NATIVE_NAMING_AGENTS.has(agentId)
}

/**
 * The conversation's own model names the branch through its adapter's disposable text task —
 * the same native naming path structured chats use, so it never lands in a user conversation.
 */
export async function generateNativeBranchSlug(input: {
  agentId: string
  context: BranchNameWorkContext
  /** Factory action recipe; a pinned per-action agent keeps CLI routing and skips this tier. */
  commandInputTemplate: string | undefined
  customPrompt: string
}): Promise<string | null> {
  if (!isNativeNamingAgent(input.agentId)) {
    return null
  }
  const generateText = getStructuredAgentSessionHost()?.deps.adapter.generateText
  if (!generateText) {
    return null
  }
  const basePrompt = buildBranchNamePrompt(input.context)
  const prompt =
    input.commandInputTemplate !== undefined
      ? renderSourceControlActionCommandTemplate(input.commandInputTemplate, {
          basePrompt,
          firstPrompt: input.context.firstPrompt,
          assistantMessage: input.context.assistantMessage ?? ''
        })
      : buildBranchNamePrompt(input.context, input.customPrompt)
  try {
    const output = await generateText({
      agent: input.agentId,
      // The native task runs on a throwaway home; the account binding is unused there.
      accountHome: { variable: 'ZCODE_HOME', path: '' },
      prompt
    })
    if (output === null) {
      return null
    }
    return sanitizeBranchSlug(output) || null
  } catch {
    return null
  }
}
