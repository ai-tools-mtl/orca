import { useEffect, useState } from 'react'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { useRoutingEntryFacts } from '../workspace-card/activity/use-routing-entry-facts'

/** The installed-agent list for manual assignment — fetched only while the entry actually has
 *  an unassigned sub-action that would need it. */
export function useEntryAgents(
  facts: Pick<ReturnType<typeof useRoutingEntryFacts>, 'inputs' | 'busy' | 'fetchAgents'>,
  onFetchError: (message: string) => void
): TuiAgent[] | undefined {
  const [agents, setAgents] = useState<TuiAgent[]>()
  const { busy, fetchAgents, inputs } = facts
  const needsAgents = inputs.some((input) =>
    input.subActions.some((action) => !action.taskId && !action.resumed)
  )
  useEffect(() => {
    if (!needsAgents || busy) {
      return
    }
    let current = true
    void fetchAgents().then(
      (next) => {
        if (current) {
          setAgents(next)
        }
      },
      (error: unknown) => {
        if (current) {
          onFetchError(String(error))
        }
      }
    )
    return () => {
      current = false
    }
  }, [needsAgents, busy, fetchAgents, onFetchError])
  return agents
}
