import { createContext, useContext, type Dispatch, type SetStateAction } from 'react'
import { cn } from '@/lib/class-names'
import type React from 'react'
import { createPortal } from 'react-dom'
import { KeyedSummary } from './worktree-card-agent-keyed-summary'

export const WorktreeAgentSummaryTarget = createContext<HTMLSpanElement | null>(null)
export const SetWorktreeAgentSummaryTarget = createContext<
  Dispatch<SetStateAction<HTMLSpanElement | null>> | undefined
>(undefined)

export function WorktreeAgentSummarySlot() {
  const setTarget = useContext(SetWorktreeAgentSummaryTarget)
  return setTarget ? <span ref={setTarget} className="max-w-1/2 shrink-0 empty:hidden" /> : null
}

/** The compact multi-root summary, inline when a summary slot host is present (portaled into
 *  it) and inside the summary panel otherwise. Null while the card shows no summary. */
export function WorktreeAgentCompactSummary(props: {
  worktreeId: string
  roots: readonly string[]
  hostFiltered: boolean
  expansion: { compactRootListExpanded: boolean; toggleCompactRootList: () => void }
}) {
  const target = useContext(WorktreeAgentSummaryTarget)
  const button = (
    <KeyedSummary
      worktreeId={props.worktreeId}
      roots={props.roots}
      hostFiltered={props.hostFiltered}
      expanded={props.expansion.compactRootListExpanded}
      onToggle={props.expansion.toggleCompactRootList}
      inline={target !== null}
    />
  )
  return target ? createPortal(button, target) : button
}

/** The compact summary panel shell under the agent rows; its content portals or inlines above. */
export function WorktreeAgentSummaryPanel(props: { expanded: boolean; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'compact-agent-summary-panel',
        props.expanded && 'compact-agent-summary-panel-expanded'
      )}
    >
      {props.children}
    </div>
  )
}
