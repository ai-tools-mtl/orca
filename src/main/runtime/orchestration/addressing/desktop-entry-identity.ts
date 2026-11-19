import type { OrchestrationPartyIdentity as OrchestrationCallerIdentity } from '../../../../shared/orchestration/mailbox/orchestration-party-identity'

// The desktop UI is no terminal, session or peer — the dispatch entry refuses all three, so the
// per-project 统一任务入口 (plan §1/§9-A) mints its own coordinator identity: one per project,
// stable across restarts, and unclaimable — no declared terminal or session resolves to this
// address, so nothing else can coordinate the entry's Run.
const DESKTOP_ENTRY_PREFIX = 'desktop-entry:'

export function desktopEntryAddress(groupId: string): string {
  return `${DESKTOP_ENTRY_PREFIX}${groupId}`
}

export function isDesktopEntryAddress(value: string | null | undefined): boolean {
  return !!value?.startsWith(DESKTOP_ENTRY_PREFIX)
}

export function desktopEntryCaller(groupId: string): OrchestrationCallerIdentity {
  const address = desktopEntryAddress(groupId)
  return Object.freeze({
    address,
    terminalHandle: address,
    paneKey: address,
    orcaSessionId: null
  })
}
