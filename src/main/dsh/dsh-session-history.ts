import type { StructuredAgentSessionHistory } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Chat rows carry the dsh ACP session id; terminal dsh-tui argv adoption stays unwired.
export const DSH_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['dsh'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: () => null
}
