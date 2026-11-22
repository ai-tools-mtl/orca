import { useTranslate } from '@/i18n/use-translate'
import type { DecisionModelSettings } from '../../../../../shared/settings/decision-model-settings'
import type { useRoutingEntryFacts } from '../workspace-card/activity/use-routing-entry-facts'
import { EntryComposer } from './entry-composer'
import { EntryAskChip } from './entry-ask-chip'
import { EntryGateChip } from './entry-gate-chip'
import { EntryLoopChip } from './entry-loop-chip'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

/** The entry facts' own submit — kept exact so the plain-request branch stays honest. */
type EntryFactsSubmit = ReturnType<typeof useRoutingEntryFacts>['submit']

/** What the composer's text means right now: a worker ask's answer, a pending gate's rejection
 *  modification, or a plain new request. The parent derives it; ask beats gate. */
export type DispatchEntryComposerMode =
  | { kind: 'ask'; messageId: string }
  | { kind: 'gate'; subActionId: string }
  | { kind: 'new' }

/** The entry conversation's composer over the three submission modes (§2/§7/new request). */
export function DispatchEntryComposer({
  busy,
  mode,
  askCount,
  askMode,
  toggleAskMode,
  gateCount,
  gateMode,
  toggleGateMode,
  loopPending,
  setLoopPending,
  answerAsk,
  gateReject,
  submit,
  decisionModel,
  routeInput,
  automatic,
  onActionError
}: {
  busy: boolean
  mode: DispatchEntryComposerMode
  askCount: number
  askMode: boolean
  toggleAskMode: (next: boolean) => void
  gateCount: number
  gateMode: boolean
  toggleGateMode: (next: boolean) => void
  loopPending: boolean
  setLoopPending: (next: boolean) => void
  answerAsk: (messageId: string, body: string) => Promise<unknown>
  gateReject: (subActionId: string, text: string) => Promise<unknown>
  submit: EntryFactsSubmit
  decisionModel?: DecisionModelSettings
  routeInput: (inputId: string, automatic: boolean) => void
  automatic: boolean
  onActionError: (error: string | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const settle = (action: () => Promise<unknown>): Promise<boolean> =>
    action().then(
      () => true,
      (error: unknown) => {
        onActionError(String(error))
        return false
      }
    )
  return (
    <EntryComposer
      accessory={
        <>
          {askCount > 0 ? (
            <EntryAskChip on={askMode} askCount={askCount} onToggle={toggleAskMode} />
          ) : null}
          {gateCount > 0 ? (
            <EntryGateChip on={gateMode} gateCount={gateCount} onToggle={toggleGateMode} />
          ) : null}
          <EntryLoopChip on={loopPending} onToggle={setLoopPending} />
        </>
      }
      disabled={busy}
      placeholder={
        mode.kind === 'ask'
          ? t(
              `${ENTRY}.composerAskPlaceholder`,
              'Answer the pending clarification — the worker resumes once it arrives…'
            )
          : mode.kind === 'gate'
            ? t(
                `${ENTRY}.composerGatePlaceholder`,
                'Modification request — the gate stays pending; the text goes back to the worker…'
              )
            : undefined
      }
      onSubmit={(text) => {
        onActionError(null)
        if (mode.kind === 'ask') {
          return settle(() => answerAsk(mode.messageId, text))
        }
        if (mode.kind === 'gate') {
          return settle(() => gateReject(mode.subActionId, text))
        }
        const loop = loopPending
        return submit(text, {
          ...(loop ? { loop: true } : {}),
          ...(decisionModel ? { decisionModel } : {})
        }).then(
          (inputId) => {
            // 提交确认成功才清除循环选项：失败重试仍对应原提交（loop 不丢）。
            if (loop) {
              setLoopPending(false)
            }
            if (inputId) {
              routeInput(inputId, automatic)
              return true
            }
            return false
          },
          (error: unknown) => {
            onActionError(String(error))
            return false
          }
        )
      }}
    />
  )
}
