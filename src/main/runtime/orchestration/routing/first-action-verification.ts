/** Supplement consumption evidence (plan §5.3 任务卡的证据), as a pure check over projected
 *  conversation items (agentSession.history rows). Callers scope the items; this module only
 *  judges order and content: the first task action after the supplement must comply, and named
 *  paths must never be read. Order comes from item creation sequence — the only ordering the
 *  delivery echo and the worker's actions share. */

export type RoutingConversationItem = {
  /** Creation sequence (journal order); non-finite values make the whole check unverifiable. */
  sequence: number
  body: {
    kind?: string
    name?: string
    role?: string
    /** Journal turn rows carry the turn id the session's actions belong to. */
    turnId?: string
    blocks?: readonly { type?: string; text?: string }[]
    input?: Record<string, unknown>
  }
}

export type SupplementFirstActionExpectation = {
  /** Creation sequence of the supplement's own user message — the delivery anchor. */
  afterSequence: number
  expect: { actionName: string; inputPath?: string }
  /** Paths no item in the supplied scope may read; a hit is 未按补充执行 evidence. */
  forbiddenPaths?: string[]
  /** The turn the supplement was steered into. When set, the echo must land in it and the
   *  first task action is judged inside it only — the zcode check→send gap can accept a steer
   *  as a NEW turn, and misdelivery must read as violation, not compliance. */
  expectedTurnId?: string
}

export type SupplementFirstActionVerdict =
  | { verdict: 'complied'; firstAction: { sequence: number; name: string; path?: string } }
  | {
      verdict: 'violated'
      firstAction?: { sequence: number; name: string; path?: string }
      reason: string
    }
  /** Delivery receipt in hand but no new task action observed yet; keep waiting, do not conclude. */
  | { verdict: 'pending'; reason: string }
  /** Initiating order cannot be established; never reads as compliance. */
  | { verdict: 'unverifiable'; reason: string }

function actionOf(item: RoutingConversationItem): { name: string; path?: string } | null {
  if (item.body.kind !== 'tool-call' || typeof item.body.name !== 'string') {
    return null
  }
  // Providers spell the read target differently: codex classifies `path`, zcode/claude may use
  // `file_path` on the raw tool input.
  const rawInput = item.body.input ?? {}
  const path =
    typeof rawInput.path === 'string'
      ? rawInput.path
      : typeof rawInput.file_path === 'string'
        ? rawInput.file_path
        : undefined
  return { name: item.body.name, ...(path !== undefined ? { path } : {}) }
}

function itemText(item: RoutingConversationItem): string {
  return (item.body.blocks ?? [])
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim()
}

/** The supplement's echo is its own user message; its sequence anchors "first action after delivery". */
export function findSupplementEchoSequence(
  items: RoutingConversationItem[],
  supplementText: string
): number | null {
  const wanted = supplementText.trim()
  if (wanted.length === 0) {
    return null
  }
  const echoes = items.filter(
    (item) => item.body.kind === 'message' && item.body.role === 'user' && itemText(item) === wanted
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: at(-1) on a filtered array is the latest echo or undefined.
  const latest = echoes.at(-1) as RoutingConversationItem | undefined
  return latest && Number.isFinite(latest.sequence) ? latest.sequence : null
}

/** Maps each item's creation sequence to the journal turn row it belongs to (the turn row
 *  covers every later item until the next turn row). */
function turnScopeOf(items: RoutingConversationItem[]): Map<number, string | null> {
  const ordered = [...items].sort((left, right) => left.sequence - right.sequence)
  const scope = new Map<number, string | null>()
  let current: string | null = null
  for (const item of ordered) {
    if (item.body.kind === 'turn' && typeof item.body.turnId === 'string') {
      current = item.body.turnId
    }
    scope.set(item.sequence, current)
  }
  return scope
}

export function verifySupplementFirstAction(
  items: RoutingConversationItem[],
  expectation: SupplementFirstActionExpectation
): SupplementFirstActionVerdict {
  if (!Number.isFinite(expectation.afterSequence)) {
    return {
      verdict: 'unverifiable',
      reason: 'the supplement echo has no usable creation sequence; initiating order is unknown'
    }
  }
  for (const item of items) {
    if (!Number.isFinite(item.sequence)) {
      return {
        verdict: 'unverifiable',
        reason: 'an item has no usable creation sequence; initiating order is unknown'
      }
    }
  }
  const turnScope = turnScopeOf(items)
  if (expectation.expectedTurnId !== undefined) {
    const landedTurn = turnScope.get(expectation.afterSequence) ?? null
    if (landedTurn !== expectation.expectedTurnId) {
      return {
        verdict: 'violated',
        reason: `the supplement echo landed in turn ${landedTurn ?? 'none'}, expected ${expectation.expectedTurnId}`
      }
    }
  }
  const after = items
    .filter((item) => item.sequence > expectation.afterSequence)
    .filter((item) =>
      expectation.expectedTurnId === undefined
        ? true
        : turnScope.get(item.sequence) === expectation.expectedTurnId
    )
    .map((item) => ({ item, action: actionOf(item) }))
    .filter((entry) => entry.action !== null)
    .sort((left, right) => left.item.sequence - right.item.sequence)
  if (after.length === 0) {
    return { verdict: 'pending', reason: 'no task action has been initiated since delivery' }
  }
  const first = after[0]!
  const { actionName, inputPath } = expectation.expect
  const firstAction = {
    sequence: first.item.sequence,
    name: first.action!.name,
    ...(first.action!.path !== undefined ? { path: first.action!.path } : {})
  }
  if (first.action!.name.toLowerCase() !== actionName.toLowerCase()) {
    return {
      verdict: 'violated',
      firstAction,
      reason: `first task action after delivery was ${first.action!.name}, expected ${actionName}`
    }
  }
  if (inputPath !== undefined && first.action!.path !== inputPath) {
    return {
      verdict: 'violated',
      firstAction,
      reason: `first task action after delivery read ${first.action!.path ?? 'no path'}, expected ${inputPath}`
    }
  }
  for (const forbidden of expectation.forbiddenPaths ?? []) {
    const hit = items.find((item) => {
      const action = actionOf(item)
      return action?.name.toLowerCase() === 'read' && action.path === forbidden
    })
    if (hit) {
      return {
        verdict: 'violated',
        firstAction,
        reason: `a task action read forbidden path ${forbidden} at sequence ${hit.sequence}`
      }
    }
  }
  return { verdict: 'complied', firstAction }
}
