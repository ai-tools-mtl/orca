import React, { useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import RoutingRequestCard from '../workspace-card/activity/RoutingEntryCard'
import { useRoutingEntryFacts } from '../workspace-card/activity/use-routing-entry-facts'

// The 统一任务入口 as the prototype's conversation surface (原型/多Agent调度-可交互原型.html):
// a stream of request cards over a bottom composer — 「向当前项目发起工作，可一次包含多项要求…」.
// Facts and actions go through the desktop entry's own runtime methods (orchestration.entry*).

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

export default function DispatchEntryChat({
  repoId,
  hostId,
  repoDisplayName,
  onClose
}: {
  repoId: string
  hostId: ExecutionHostId
  repoDisplayName: string
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const target = ipcOrRuntimeTargetForHostId(hostId)
  const facts = useRoutingEntryFacts(target, repoId)
  const [draft, setDraft] = useState('')
  const streamRef = useRef<HTMLDivElement | null>(null)

  const inputCount = facts.inputs.length
  useEffect(() => {
    const stream = streamRef.current
    if (stream) {
      stream.scrollTop = stream.scrollHeight
    }
  }, [inputCount])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-dispatch-entry-chat="">
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">
            {t(`${ENTRY}.paneTitle`, 'Task entry')} · {repoDisplayName}
          </span>
          {facts.paused ? (
            <Badge variant="destructive">{t(`${ENTRY}.paused`, 'Paused')}</Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={facts.busy}
            onClick={() => void facts.refresh()}
          >
            {t(`${ENTRY}.refresh`, 'Refresh')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t(`${ENTRY}.close`, 'Close')}
          </Button>
        </div>
      </div>
      <div ref={streamRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek px-4 py-3">
        {facts.error ? <p className="text-destructive text-xs">{facts.error}</p> : null}
        {inputCount === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <h2 className="text-sm font-medium">
              {t(`${ENTRY}.emptyTitle`, 'Start work on this project')}
            </h2>
            <p className="text-muted-foreground max-w-sm text-xs">
              {t(
                `${ENTRY}.emptyHint`,
                'One message may contain several requests. It is saved first and shown as Received; routing splits the independent requests, dependent steps stay with one worker.'
              )}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {facts.inputs.map((input) => (
              <RoutingRequestCard
                key={input.inputId}
                input={input}
                busy={facts.busy}
                onHandback={(subActionId, dispatchId) =>
                  void facts.handback(subActionId, dispatchId)
                }
                onSendSupplement={(subActionId, text) => {
                  const dispatch = input.subActions.find(
                    (subAction) => subAction.subActionId === subActionId
                  )?.claimedBy
                  if (dispatch) {
                    void facts.sendSupplement(input.inputId, subActionId, dispatch, text)
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>
      <div className="px-4 pb-4 pt-2">
        <form
          className="flex items-end gap-1.5 rounded-xl border p-2"
          onSubmit={(event) => {
            event.preventDefault()
            const raw = new FormData(event.currentTarget).get('request')
            const text = typeof raw === 'string' ? raw.trim() : ''
            if (!text) {
              return
            }
            void facts.submit(text).then(() => setDraft(''))
          }}
        >
          <textarea
            name="request"
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder={t(`${ENTRY}.composerPlaceholder`, 'Describe a request for this project')}
            aria-label={t(`${ENTRY}.composerAria`, 'Task input')}
            className="max-h-32 min-h-0 min-w-0 flex-1 resize-none border-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Button type="submit" size="sm" disabled={facts.busy || !draft.trim()}>
            {t(`${ENTRY}.send`, 'Send')}
          </Button>
        </form>
      </div>
    </div>
  )
}
