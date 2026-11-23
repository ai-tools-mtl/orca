import { translate } from '@/i18n/i18n'
import type { AgentSessionHostStatusPresentation } from '../../../../../../shared/agent-session/view/agent-session-host-status-rows'
import { AGENT_SESSION_HOST_STATUS_COPY } from '../../../../../../shared/agent-session/view/agent-session-host-status-rows'
import type { BotContextChange } from '../../../../../../shared/bots/bot-context-note'
import { BOT_CONTEXT_NOTE_COPY } from '../../../../../../shared/bots/bot-context-note'

const noticeWord =
  (key: string, fallback: string): (() => string) =>
  () =>
    translate(key, fallback)

export const HOST_STATUS_WORDS: Record<AgentSessionHostStatusPresentation, () => string> = {
  'history-repaired': noticeWord(
    'components.native-chat.notices.historyRepaired',
    AGENT_SESSION_HOST_STATUS_COPY['history-repaired']
  ),
  'history-item-too-large': noticeWord(
    'components.native-chat.notices.historyItemTooLarge',
    AGENT_SESSION_HOST_STATUS_COPY['history-item-too-large']
  ),
  'continued-outside': noticeWord(
    'components.native-chat.notices.continuedOutside',
    AGENT_SESSION_HOST_STATUS_COPY['continued-outside']
  ),
  'continued-outside-rewound': noticeWord(
    'components.native-chat.notices.continuedOutsideRewound',
    AGENT_SESSION_HOST_STATUS_COPY['continued-outside-rewound']
  )
}

export const BOT_CONTEXT_WORDS: Record<BotContextChange, () => string> = {
  soul: () => translate('components.native-chat.botContext.soul', BOT_CONTEXT_NOTE_COPY.soul),
  memory: () => translate('components.native-chat.botContext.memory', BOT_CONTEXT_NOTE_COPY.memory)
}
