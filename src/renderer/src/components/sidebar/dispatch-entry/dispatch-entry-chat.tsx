import React, { useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Check, SendHorizonal, Sparkles, TriangleAlert } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import RoutingRequestCard from '../workspace-card/activity/RoutingEntryCard'
import { useRoutingEntryFacts } from '../workspace-card/activity/use-routing-entry-facts'

// The 统一任务入口 as the prototype's conversation (原型 .input-row): the request is a
// right-aligned bubble with its receipt meta (id + 已收到 + routing state), and the answer —
// the sub-action facts card — sits left beneath it. Composer pinned at the pane bottom.

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

export default function DispatchEntryChat({
  repoId,
  hostId,
  repoDisplayName
}: {
  repoId: string
  hostId: ExecutionHostId
  repoDisplayName: string
}): React.JSX.Element {
  const t = useTranslate()
  const target = ipcOrRuntimeTargetForHostId(hostId)
  const facts = useRoutingEntryFacts(target, repoId)
  const [draft, setDraft] = useState('')
  const [routingHint, setRoutingHint] = useState<string | null>(null)
  const streamRef = useRef<HTMLDivElement | null>(null)

  const inputCount = facts.inputs.length
  useEffect(() => {
    const stream = streamRef.current
    if (stream) {
      stream.scrollTop = stream.scrollHeight
    }
  }, [inputCount])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-chat-pane" data-dispatch-entry-chat="">
      <div className="flex items-center gap-2 border-b border-black/10 px-5 py-2.5 dark:border-white/10">
        <div className="mx-auto flex min-w-0 w-full max-w-[760px] items-center gap-2">
          <span className="truncate text-sm font-medium">
            {t(`${ENTRY}.paneTitle`, 'Task entry')} · {repoDisplayName}
          </span>
          {facts.paused ? (
            <Badge variant="destructive">{t(`${ENTRY}.paused`, 'Paused')}</Badge>
          ) : null}
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            disabled={facts.busy}
            onClick={() => void facts.setPaused(!facts.paused)}
          >
            {facts.paused ? t(`${ENTRY}.resume`, 'Resume') : t(`${ENTRY}.pause`, 'Pause')}
          </Button>
        </div>
      </div>
      <div
        ref={streamRef}
        className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek [scrollbar-gutter:stable_both-edges]"
      >
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-5 py-4">
          {facts.error ? <p className="text-destructive text-xs">{facts.error}</p> : null}
          {facts.approvals.map((approval) => (
            <div
              key={approval.approvalId}
              className="flex flex-col gap-1.5 rounded-lg border border-status-warning/30 bg-status-warning/5 p-2.5"
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-status-warning">
                <TriangleAlert className="size-3.5" />
                {t(`${ENTRY}.approvalTitle`, 'The worker asks for approval')}
              </div>
              <p className="text-sm">{approval.title}</p>
              {approval.detail ? (
                <p className="text-muted-foreground text-xs whitespace-pre-wrap">
                  {approval.detail}
                </p>
              ) : null}
              {approval.reason ? (
                <p className="text-muted-foreground text-xs">{approval.reason}</p>
              ) : null}
              <p className="font-mono text-[10px] text-muted-foreground opacity-70">
                {t(`${ENTRY}.executionTarget`, 'Execution target')} {approval.workerHandle}
              </p>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={facts.busy}
                  onClick={() =>
                    void facts.answerApproval(approval.dispatchId, approval.approvalId, 'allow')
                  }
                >
                  {t(`${ENTRY}.allow`, 'Allow')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={facts.busy}
                  onClick={() =>
                    void facts.answerApproval(approval.dispatchId, approval.approvalId, 'deny')
                  }
                >
                  {t(`${ENTRY}.deny`, 'Deny')}
                </Button>
              </div>
            </div>
          ))}
          {inputCount === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
              <div className="grid size-11 place-items-center rounded-xl border bg-secondary text-muted-foreground">
                <Sparkles className="size-5" />
              </div>
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
            facts.inputs.map((input) => (
              <div key={input.inputId} className="flex flex-col gap-1.5">
                <div className="max-w-[82%] self-end rounded-[14px] border bg-secondary px-3 py-2 text-[13px] whitespace-pre-wrap break-words">
                  {input.text}
                </div>
                <div className="flex items-center gap-2 self-end pr-0.5 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1 font-medium text-status-success">
                    <span className="grid size-3.5 place-items-center rounded-full bg-status-success-background">
                      <Check className="size-2.5" />
                    </span>
                    {t(`${ENTRY}.registered`, 'Received')}
                  </span>
                  <span>
                    ·{' '}
                    {input.decisionStatus === 'decided'
                      ? t(`${ENTRY}.decided`, 'Decided')
                      : t(`${ENTRY}.awaitingRouting`, 'Awaiting routing')}
                  </span>
                  <span className="font-mono text-[10px] opacity-60">{input.inputId}</span>
                  {input.decisionStatus !== 'decided' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="ms-1"
                      disabled={facts.busy}
                      onClick={() =>
                        void facts.autoRoute(input.inputId).then((result) => {
                          if (result && result.routed === false && result.reason) {
                            setRoutingHint(result.reason)
                          }
                        })
                      }
                    >
                      {t(`${ENTRY}.autoRoute`, 'Auto-route')}
                    </Button>
                  ) : null}
                </div>
                {input.subActions.length > 0 ? (
                  <RoutingRequestCard
                    input={input}
                    busy={facts.busy}
                    reviews={facts.reviews}
                    onAcceptReview={(taskId) => void facts.acceptReview(taskId)}
                    onFetchWorkers={() => facts.fetchWorkers()}
                    onReassign={(subActionId, targetDispatchId) => {
                      void facts.claim(subActionId, targetDispatchId).then(() => {
                        const subAction = input.subActions.find(
                          (candidate) => candidate.subActionId === subActionId
                        )
                        const text = subAction?.lastSupplementText ?? input.text
                        if (text) {
                          void facts.sendSupplement(
                            input.inputId,
                            subActionId,
                            targetDispatchId,
                            text
                          )
                        }
                      })
                    }}
                    onHandback={(subActionId, dispatchId) =>
                      void facts.handback(subActionId, dispatchId)
                    }
                    onSendSupplement={(subActionId, text) => {
                      const subAction = input.subActions.find(
                        (candidate) => candidate.subActionId === subActionId
                      )
                      const dispatch = subAction?.claimedBy ?? subAction?.lastTargetDispatchId
                      if (dispatch) {
                        void facts.sendSupplement(input.inputId, subActionId, dispatch, text)
                      }
                    }}
                  />
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>
      {routingHint ? (
        <div className="mx-auto w-full max-w-[760px] px-5 pb-1">
          <div className="flex flex-col gap-1.5 rounded-lg border border-status-warning/30 bg-status-warning/5 p-2.5">
            <p className="text-sm">
              {t(`${ENTRY}.routingHintTitle`, 'Auto-routing is unavailable.')}
            </p>
            <p className="text-muted-foreground text-xs">{routingHint}</p>
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => useAppStore.getState().setActiveView('settings')}
              >
                {t(`${ENTRY}.goConfigure`, 'Configure the decision model')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="px-5 pb-4 pt-2">
        <form
          className="mx-auto w-full max-w-[760px] rounded-xl border border-input bg-card p-2 pb-1 shadow-xs"
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
            className="max-h-32 min-h-0 min-w-0 flex-1 resize-none border-none bg-transparent px-2 pt-1 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-2 px-1.5 pb-0.5">
            <span className="text-muted-foreground text-[11px]">
              {t(`${ENTRY}.sendHint`, 'Enter to send · Shift+Enter for a newline')}
            </span>
            <span className="flex-1" />
            <Button
              type="submit"
              size="icon"
              disabled={facts.busy || !draft.trim()}
              aria-label={t(`${ENTRY}.send`, 'Send')}
            >
              <SendHorizonal className="size-4" />
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
