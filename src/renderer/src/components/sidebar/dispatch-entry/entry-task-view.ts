import { motionSafeScrollBehavior } from '@/hooks/usePrefersReducedMotion'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../../shared/agent-launch/catalog/tui-agent-display-names'
import type { RoutingEntrySubAction } from '../workspace-card/activity/routing-entry-model'

/** The task card's visual state, derived from execution + pending approvals (§9-A facts). */
export type EntryCardState = 'idle' | 'working' | 'attention' | 'done' | 'failed'

export function entryCardStateOf(
  action: RoutingEntrySubAction,
  pendingApproval: boolean
): EntryCardState {
  if (pendingApproval || action.execution?.status === 'attention') {
    return 'attention'
  }
  switch (action.execution?.status) {
    case 'dispatched':
      return 'working'
    case 'completed':
      return 'done'
    case 'failed':
    case 'circuit_broken':
      return 'failed'
    default:
      return 'idle'
  }
}

export function isEntryStageWaitingForDispatch(action: RoutingEntrySubAction): boolean {
  return Boolean(
    action.stageKind &&
    action.stageKind !== 'merge' &&
    !action.taskId &&
    !action.execution &&
    !action.queuedAt
  )
}

/** The 看板 lane (原型 BUCKETS): attention/working/done/idle. */
export function bucketOfCardState(
  state: EntryCardState
): 'attention' | 'working' | 'done' | 'idle' {
  if (state === 'attention' || state === 'failed') {
    return 'attention'
  }
  if (state === 'done') {
    return 'done'
  }
  if (state === 'working') {
    return 'working'
  }
  return 'idle'
}

/** CX/CL/ZC style mark for the candidate/agent logo tile; initials for unknown agents. */
const AGENT_MARKS: Partial<Record<TuiAgent, string>> = {
  codex: 'CX',
  claude: 'CL',
  zcode: 'ZC'
}

export function agentMarkOf(agent: string): string {
  const mark = AGENT_MARKS[agent as TuiAgent]
  if (mark) {
    return mark
  }
  return displayNameOf(agent)
    .split(' ')
    .map((word) => word[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

export function displayNameOf(agent: string): string {
  return TUI_AGENT_DISPLAY_NAMES[agent as TuiAgent] ?? agent
}

export function useWorktreeName(
  repoId: string,
  worktreeId: string | null | undefined
): string | undefined {
  return useAppStore((state) =>
    worktreeId
      ? state.worktreesByRepo[repoId]?.find((worktree) => worktree.id === worktreeId)?.displayName
      : undefined
  )
}

export function entryDateOf(value?: string): Date | undefined {
  if (!value) {
    return undefined
  }
  const date = new Date(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value
  )
  return Number.isNaN(date.getTime()) ? undefined : date
}

export function entryLocalTime(utcSqlite: string): string {
  return (
    entryDateOf(utcSqlite)?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) ??
    utcSqlite
  )
}

/** 原型 flash: draw a 2px ring around the located card for a moment. */
export function flashEntryElement(el: HTMLElement | null, focus = false): void {
  if (!el) {
    return
  }
  const disclosureSelector = 'details[data-entry-timeline-disclosure]'
  let disclosure = el.closest<HTMLDetailsElement>(disclosureSelector)
  while (disclosure) {
    disclosure.open = true
    disclosure = disclosure.parentElement?.closest<HTMLDetailsElement>(disclosureSelector) ?? null
  }
  if (el.matches('button[data-entry-task-trigger][aria-expanded="false"]')) {
    el.click()
  }
  if (focus) {
    el.focus({ preventScroll: true })
  }
  el.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: 'center' })
  el.style.transition = 'box-shadow 200ms'
  el.style.boxShadow = '0 0 0 2px var(--ring)'
  window.setTimeout(() => {
    el.style.boxShadow = ''
  }, 700)
}

export function locateEntryTimelineCard(stream: HTMLElement | null, id: string): boolean {
  const target = stream?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? null
  flashEntryElement(target, true)
  return target !== null
}
