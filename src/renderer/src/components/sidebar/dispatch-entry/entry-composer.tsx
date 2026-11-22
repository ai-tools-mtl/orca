import { useState, type ReactNode } from 'react'
import { ArrowUp } from 'lucide-react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS } from '@/components/native-chat/appearance/native-chat-appearance-style'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

export function EntryComposer({
  accessory,
  disabled,
  placeholder,
  onSubmit
}: {
  accessory?: ReactNode
  disabled?: boolean
  /** Overrides the new-request placeholder (澄清回复模式提示的是回答语义). */
  placeholder?: string
  /** Resolves true when the request was accepted — the draft clears only then. */
  onSubmit: (text: string) => Promise<boolean>
}): React.JSX.Element {
  const t = useTranslate()
  const [draft, setDraft] = useState('')
  return (
    <div className="scrollbar-sleek flex-none overflow-hidden border-t border-border bg-chat-pane px-3 pt-3 pb-4 [scrollbar-gutter:stable_both-edges] sm:px-4">
      <div className={cn(NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS, 'gap-0')}>
        <form
          className="@container w-full rounded-xl border border-chat-composer-border bg-chat-composer-surface p-1.5 shadow-xs [contain:paint]"
          onSubmit={(event) => {
            event.preventDefault()
            const raw = new FormData(event.currentTarget).get('request')
            const text = typeof raw === 'string' ? raw.trim() : ''
            if (!text || disabled) {
              return
            }
            void onSubmit(text).then((accepted) => {
              if (accepted) {
                setDraft((current) => (current.trim() === text ? '' : current))
              }
            })
          }}
        >
          <textarea
            name="request"
            rows={1}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              const el = event.currentTarget
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 120)}px`
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder={
              placeholder ??
              t(
                `${ENTRY}.composerPlaceholder`,
                'Describe a request for this project; it may contain several asks at once…'
              )
            }
            aria-label={t(`${ENTRY}.composerAria`, 'Task input')}
            className="block max-h-[120px] min-h-0 w-full resize-none border-none bg-transparent px-2 py-1.5 text-sm text-chat-foreground outline-none placeholder:text-chat-foreground-faint"
          />
          <div className="flex flex-wrap items-center gap-2 px-1 pt-0.5 pb-0.5">
            {accessory}
            <span className="ms-auto hidden flex-wrap items-center gap-1.5 text-2xs text-muted-foreground @lg:flex">
              <ShortcutKeyCombo keys={['Enter']} />
              {t(`${ENTRY}.sendHintVerb`, 'to send')} ·{' '}
              <ShortcutKeyCombo keys={['Shift', 'Enter']} />
              {t(`${ENTRY}.sendHintNewline`, 'for a newline')}
            </span>
            <Button
              type="submit"
              variant="default"
              size="icon"
              className="ms-auto size-8 shrink-0 @lg:ms-0"
              disabled={disabled || !draft.trim()}
              aria-label={t(`${ENTRY}.send`, 'Send')}
            >
              <ArrowUp className="size-4" />
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
