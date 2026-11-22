import { createContext, useContext, type Dispatch, type SetStateAction } from 'react'

export const WorktreeAgentSummaryTarget = createContext<HTMLSpanElement | null>(null)
export const SetWorktreeAgentSummaryTarget = createContext<
  Dispatch<SetStateAction<HTMLSpanElement | null>> | undefined
>(undefined)

export function WorktreeAgentSummarySlot() {
  const setTarget = useContext(SetWorktreeAgentSummaryTarget)
  return setTarget ? <span ref={setTarget} className="max-w-1/2 shrink-0 empty:hidden" /> : null
}
