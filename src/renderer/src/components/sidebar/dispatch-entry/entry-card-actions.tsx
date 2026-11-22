import { useState } from 'react'
import { ExternalLink, FileDiff, MessageSquare, Pause, Play, Send } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { displayNameOf, useWorktreeName } from './entry-task-view'
import type {
  RoutingEntrySubAction,
  RoutingEntryWorker
} from '../workspace-card/activity/routing-entry-model'

const ENTRY = 'auto.components.sidebar.RoutingEntryCard'

const TA_BTN =
  'inline-flex h-[26px] items-center gap-1 rounded-md px-2 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50'

function WorkerOption({
  worker,
  repoId,
  disabled,
  onSelect
}: {
  worker: RoutingEntryWorker
  repoId: string
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  const worktreeName = useWorktreeName(repoId, worker.worktreeId)
  const label = [worker.agent && displayNameOf(worker.agent), worktreeName]
    .filter(Boolean)
    .join(' · ')
  return (
    <button
      type="button"
      disabled={disabled}
      className="flex min-h-7 items-center gap-1.5 rounded-md px-1.5 py-1 text-start text-2xs hover:bg-accent disabled:opacity-50"
      onClick={onSelect}
    >
      <span className="min-w-0 truncate">{label || worker.handle}</span>
      {label && <span className="min-w-0 truncate text-muted-foreground">{worker.handle}</span>}
    </button>
  )
}

export function EntryCardActions({
  action,
  repoId,
  inputText,
  busy,
  paused,
  showSupplementForm,
  retryable,
  onTogglePause,
  onOpenSession,
  onOpenDiff,
  onHandback,
  onReassign,
  onFetchWorkers,
  onSendSupplement
}: {
  action: RoutingEntrySubAction
  repoId: string
  inputText: string
  busy?: boolean
  paused: boolean
  showSupplementForm: boolean
  retryable: boolean
  onTogglePause?: (paused: boolean) => void
  onOpenSession?: () => void
  onOpenDiff?: () => void
  onHandback?: (subActionId: string, dispatchId: string) => Promise<void>
  onReassign?: (fromDispatch: string | null, targetDispatchId: string) => Promise<void>
  onFetchWorkers?: () => Promise<RoutingEntryWorker[]>
  onSendSupplement?: (subActionId: string, text: string) => Promise<void> | void
}): React.JSX.Element | null {
  const t = useTranslate()
  const [picker, setPicker] = useState<{
    fromDispatch: string | null
    candidates: RoutingEntryWorker[]
  } | null>(null)
  const [assignmentPending, setAssignmentPending] = useState(false)
  const [assignmentError, setAssignmentError] = useState<string | null>(null)
  const fromDispatch = action.claimedBy ?? null
  const canAssign = Boolean((fromDispatch || action.execution) && onFetchWorkers && onReassign)

  async function runAssignment(action: () => Promise<void>): Promise<void> {
    setAssignmentPending(true)
    setAssignmentError(null)
    try {
      await action()
    } catch (error) {
      setAssignmentError(error instanceof Error ? error.message : String(error))
    } finally {
      setAssignmentPending(false)
    }
  }

  function sendSupplement(text: string): void {
    if (onSendSupplement) {
      void Promise.resolve(onSendSupplement(action.subActionId, text)).catch(() => undefined)
    }
  }

  if (
    !(
      onOpenSession ||
      onOpenDiff ||
      onTogglePause ||
      showSupplementForm ||
      retryable ||
      fromDispatch ||
      canAssign ||
      assignmentError
    )
  ) {
    return null
  }
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-t border-border bg-muted/40 px-2 py-1">
      {onOpenSession ? (
        <button type="button" disabled={busy} className={TA_BTN} onClick={onOpenSession}>
          <ExternalLink className="size-3" />
          {t(`${ENTRY}.openSession`, 'Open session')}
        </button>
      ) : null}
      {onOpenDiff ? (
        <button type="button" disabled={busy} className={TA_BTN} onClick={onOpenDiff}>
          <FileDiff className="size-3" />
          {t(`${ENTRY}.openDiff`, 'Workspace · Diff')}
        </button>
      ) : null}
      {onTogglePause ? (
        <button
          type="button"
          disabled={busy}
          className={`inline-flex h-[26px] items-center gap-1 rounded-md px-2 text-2xs transition-colors disabled:pointer-events-none disabled:opacity-50 ${
            paused
              ? 'bg-secondary text-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          }`}
          onClick={() => onTogglePause(!paused)}
        >
          {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
          {paused ? t(`${ENTRY}.resume`, 'Resume') : t(`${ENTRY}.pause`, 'Pause')}
        </button>
      ) : null}
      {retryable ? (
        <button
          type="button"
          disabled={busy}
          className="inline-flex h-[26px] items-center gap-1 rounded-md px-2 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          onClick={() => sendSupplement(action.lastSupplementText ?? inputText)}
        >
          {t(`${ENTRY}.retry`, 'Retry')}
        </button>
      ) : null}
      {fromDispatch && onHandback ? (
        <button
          type="button"
          disabled={busy || assignmentPending}
          className="inline-flex h-[26px] items-center gap-1 rounded-md px-2 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          onClick={() =>
            void runAssignment(async () => {
              await onHandback(action.subActionId, fromDispatch)
              setPicker(null)
            })
          }
        >
          {t(`${ENTRY}.handback`, 'Unassign')}
        </button>
      ) : null}
      {canAssign && onFetchWorkers ? (
        <button
          type="button"
          disabled={busy || assignmentPending}
          aria-expanded={picker !== null}
          className="inline-flex h-[26px] items-center gap-1 rounded-md px-2 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          onClick={() => {
            if (picker) {
              setPicker(null)
              return
            }
            void runAssignment(async () => {
              const workers = await onFetchWorkers()
              setPicker({
                fromDispatch,
                candidates: workers.filter(
                  (worker) =>
                    worker.dispatchId !== fromDispatch &&
                    worker.dispatchStatus === 'dispatched' &&
                    !worker.pendingApproval
                )
              })
            })
          }}
        >
          {fromDispatch
            ? t(`${ENTRY}.reassign`, 'Transfer to another agent')
            : t(`${ENTRY}.assignExisting`, 'Assign to an agent')}
        </button>
      ) : null}
      {picker && onReassign ? (
        <div className="flex w-full flex-col gap-0.5 rounded-lg border border-dashed border-border p-1">
          {picker.candidates.length === 0 ? (
            <p className="px-1.5 py-1 text-2xs text-muted-foreground">
              {t(`${ENTRY}.noOtherWorkers`, 'No eligible agents are available.')}
            </p>
          ) : null}
          {picker.candidates.map((worker) => (
            <WorkerOption
              key={worker.dispatchId}
              worker={worker}
              repoId={repoId}
              disabled={Boolean(busy || assignmentPending)}
              onSelect={() =>
                void runAssignment(async () => {
                  await onReassign(picker.fromDispatch, worker.dispatchId)
                  setPicker(null)
                })
              }
            />
          ))}
        </div>
      ) : null}
      {assignmentError ? (
        <p role="alert" className="w-full px-2 text-2xs text-destructive">
          {assignmentError}
        </p>
      ) : null}
      <span className="flex-1" />
      {showSupplementForm ? (
        <form
          className="flex h-[26px] min-w-[min(100%,200px)] max-w-[380px] flex-1 items-center gap-2 rounded-lg border border-input bg-background pr-0.5 pl-2 transition-shadow focus-within:border-ring focus-within:shadow-[0_0_0_2px_color-mix(in_srgb,var(--ring)_25%,transparent)]"
          onSubmit={(event) => {
            event.preventDefault()
            const form = event.currentTarget
            const value = new FormData(form).get('supplement')
            if (typeof value === 'string' && value.trim()) {
              sendSupplement(value.trim())
              form.reset()
            }
          }}
        >
          <MessageSquare className="size-3 shrink-0 text-chat-foreground-faint" />
          <input
            name="supplement"
            required
            disabled={busy}
            aria-label={t(
              `${ENTRY}.supplementPlaceholder`,
              'Supplement · deliver to the active turn'
            )}
            placeholder={t(
              `${ENTRY}.supplementPlaceholder`,
              'Supplement · deliver to the active turn'
            )}
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-[color-mix(in_srgb,var(--muted-foreground)_70%,transparent)]"
          />
          <button
            type="submit"
            aria-label={t(`${ENTRY}.send`, 'Send')}
            className="grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Send className="size-3" />
          </button>
        </form>
      ) : null}
    </div>
  )
}
