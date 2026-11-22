import { ChevronDown, ClipboardCheck, GitMerge, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslate } from '@/i18n/use-translate'
import type { RoutingEntrySubAction } from '../workspace-card/activity/routing-entry-model'
import { ENTRY_MESSAGE_SURFACE, EntryMessageHeader, EntryMessageText } from './entry-message'
import { displayNameOf } from './entry-task-view'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

export function EntryStageCheckpoint({
  action,
  state,
  context,
  busy,
  onGrant,
  onReject
}: {
  action: RoutingEntrySubAction
  state: 'waiting' | 'confirmed' | 'plan-invalid' | 'merged' | 'merge-failed'
  context?: React.ReactNode
  busy?: boolean
  onGrant?: () => void
  /** Present on non-merge waiting gates: reject with a modification request, sent back to the
   *  stage's worker on its own worktree; the gate stays ungranted until it re-reports. */
  onReject?: (text: string) => Promise<unknown>
}): React.JSX.Element {
  const t = useTranslate()
  const merge = action.stageKind === 'merge'
  const commit = action.mergeReceipt?.commitSha?.slice(0, 7)
  const statusByState = {
    waiting: [
      merge
        ? t(`${ENTRY}.stageMergeAwaiting`, 'Merge awaits your confirmation')
        : t(`${ENTRY}.messageAwaitingConfirmation`, 'Awaiting confirmation'),
      'warning'
    ],
    confirmed: [t(`${ENTRY}.timelineConfirmed`, 'Confirmed'), 'success'],
    'plan-invalid': [t(`${ENTRY}.stagePlanBroken`, 'Plan not usable'), 'error'],
    merged: [t(`${ENTRY}.stageMerged`, 'Merged into main branch'), 'success'],
    'merge-failed': [t(`${ENTRY}.stageMergeFailed`, 'Merge failed'), 'error']
  } as const
  const [status, tone] = statusByState[state]
  return (
    <article className={`${ENTRY_MESSAGE_SURFACE} px-3 py-2.5`}>
      <EntryMessageHeader
        icon={merge ? GitMerge : ClipboardCheck}
        type={
          merge
            ? t(`${ENTRY}.stageMergeType`, 'Merge checkpoint')
            : t(`${ENTRY}.messageStageApproval`, 'Stage approval')
        }
        status={state === 'merged' && commit ? `${status} · ${commit}` : status}
        tone={tone}
      />
      {context ?? <EntryMessageText as="h4" text={action.text} className="font-medium" />}
      {state === 'plan-invalid' ? (
        <div className="mt-1 space-y-1 text-muted-foreground">
          <EntryMessageText
            text={
              action.planParseError ??
              t(`${ENTRY}.stagePlanBrokenDetail`, 'orca-plan missing or failed to parse')
            }
          />
          <p className="text-xs">
            {t(`${ENTRY}.stagePlanBrokenGuide`, 'Add more detail in the entry to re-run planning.')}
          </p>
        </div>
      ) : null}
      {state === 'merge-failed' && action.assignmentError ? (
        <div className="mt-1 space-y-1 text-muted-foreground">
          <EntryMessageText text={action.assignmentError} />
          <p className="text-xs">
            {t(
              `${ENTRY}.stageMergeRetryHint`,
              'The pump retries the merge automatically once resolved.'
            )}
          </p>
        </div>
      ) : null}
      {action.planStages ? (
        <Collapsible className="mt-1">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="group h-auto w-full justify-start gap-2 rounded-lg px-3 py-2 text-start focus-visible:ring-inset"
            >
              <span className="min-w-0 flex-1 text-settings-detail">
                {t(`${ENTRY}.messageViewPlan`, 'View plan')}
              </span>
              <ChevronDown
                className="ms-auto size-4 shrink-0 text-muted-foreground group-data-[state=open]:rotate-180"
                aria-hidden="true"
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pb-1">
            <div className="text-xs text-muted-foreground">
              {t(`${ENTRY}.stagePlanSummary`, 'Plan: {{n}} stages', {
                n: action.planStages.length
              })}
            </div>
            <div className="mt-1 space-y-0.5">
              {action.planStages.map((stage, index) => (
                <Collapsible key={index}>
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="group h-auto w-full justify-start gap-1.5 rounded-md px-2 py-1.5 text-start text-xs focus-visible:ring-inset"
                    >
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {index + 1}.
                      </span>
                      <span className="min-w-0 flex-1 truncate">{stage.title}</span>
                      {stage.agent ? (
                        <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                          {displayNameOf(stage.agent)}
                        </span>
                      ) : null}
                      <ChevronDown
                        className="size-3.5 shrink-0 text-muted-foreground group-data-[state=open]:rotate-180"
                        aria-hidden="true"
                      />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="ps-7 pe-2 pb-1.5">
                    <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {stage.spec}
                    </span>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {state === 'waiting' ? (
        <div className="mt-2 space-y-2">
          {onReject ? (
            <form
              className="flex h-[26px] min-w-0 items-center gap-2 rounded-lg border border-input bg-background pr-0.5 pl-2 transition-shadow focus-within:border-ring focus-within:shadow-[0_0_0_2px_color-mix(in_srgb,var(--ring)_25%,transparent)]"
              onSubmit={(event) => {
                event.preventDefault()
                const form = event.currentTarget
                const value = new FormData(form).get('reject')
                if (typeof value === 'string' && value.trim()) {
                  void onReject(value.trim())
                    .then(() => form.reset())
                    .catch(() => undefined)
                }
              }}
            >
              <MessageSquare className="size-3 shrink-0 text-chat-foreground-faint" />
              <input
                name="reject"
                required
                disabled={busy}
                aria-label={t(
                  `${ENTRY}.stageRejectPlaceholder`,
                  'Modification request · reject and send back to the worker'
                )}
                placeholder={t(
                  `${ENTRY}.stageRejectPlaceholder`,
                  'Modification request · reject and send back to the worker'
                )}
                className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-[color-mix(in_srgb,var(--muted-foreground)_70%,transparent)]"
              />
              <Button type="submit" size="xs" variant="outline" disabled={busy}>
                {t(`${ENTRY}.stageReject`, 'Reject & rework')}
              </Button>
            </form>
          ) : null}
          <div className="flex justify-end">
            <Button size="xs" disabled={busy} onClick={onGrant}>
              {t(`${ENTRY}.stageGrant`, 'Confirm & release')}
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  )
}
