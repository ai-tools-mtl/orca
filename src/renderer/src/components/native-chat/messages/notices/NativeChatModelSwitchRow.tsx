import { ArrowLeftRight } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatNoticeLook } from '../../../../../../shared/native-chat/transcript/notices/native-chat-notice'

/** Announces a model switch mid-conversation: polite, once, without stealing the reader's place. */
export function NativeChatModelSwitchRow({
  look
}: {
  look: Extract<NativeChatNoticeLook, { kind: 'model-switch' }>
}) {
  const t = useTranslate()
  return (
    <p className="flex min-w-0 items-center justify-center gap-1.5 select-text text-xs text-chat-foreground-faint">
      <ArrowLeftRight className="size-3.5 shrink-0" aria-hidden="true" />
      <span role="status" aria-live="polite" className="whitespace-normal">
        {t(
          'components.native-chat.notices.modelSwitched',
          'Model switched: {{from}} → {{to}}',
          look
        )}
      </span>
    </p>
  )
}
