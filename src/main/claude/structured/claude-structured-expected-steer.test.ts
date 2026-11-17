import { describe, expect, it, vi } from 'vitest'
import { steerExpectedClaudeTurn } from './claude-structured-expected-steer'
import { sessionFor, userMessage } from './claude-structured-dispatch-test-support'
import type { ClaudeSession } from './claude-structured-session-state'

const SESSION = '819cf9f8-e43c-4ad7-b50f-54aa158a726a'
const OPEN_TURN = 'turn-open-1'

function runningSession(currentTurnId: string | null): { session: ClaudeSession; sent: unknown[] } {
  const sent: unknown[] = []
  const session = sessionFor(
    vi.fn(async (message: Record<string, unknown>, beforeDispatch?: () => Promise<void>) => {
      await beforeDispatch?.()
      sent.push(structuredClone(message))
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the strict steer reads only these translator facts.
  session.translator = {
    openTurnHasInputWork: true,
    commandTurnId: null,
    currentTurnId
  } as unknown as ClaudeSession['translator']
  return { session, sent }
}

const input = {
  sessionId: SESSION,
  clientMessageId: 'client-1',
  body: userMessage([{ type: 'text', text: 'change course' }]),
  expectedTurnId: OPEN_TURN
}

describe('targeted delivery for Claude', () => {
  it('steers the named open turn as a priority message', async () => {
    const { session, sent } = runningSession(OPEN_TURN)

    expect(await steerExpectedClaudeTurn(session, input)).toEqual({
      status: 'delivered',
      turnId: OPEN_TURN,
      via: 'steer'
    })
    expect(sent).toEqual([expect.objectContaining({ priority: 'now' })])
  })

  it('refuses without writing when the running turn is not the named one', async () => {
    const { session, sent } = runningSession('turn-other')

    expect(await steerExpectedClaudeTurn(session, input)).toEqual({
      status: 'refused',
      kind: 'turn-not-active',
      expectedTurnId: OPEN_TURN
    })
    expect(sent).toEqual([])
  })

  it('refuses without writing when no turn carries input work', async () => {
    const { session, sent } = runningSession(OPEN_TURN)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrow the flags under test.
    session.translator = {
      openTurnHasInputWork: false,
      commandTurnId: null,
      currentTurnId: OPEN_TURN
    } as unknown as ClaudeSession['translator']

    expect(await steerExpectedClaudeTurn(session, input)).toEqual({
      status: 'refused',
      kind: 'turn-not-active',
      expectedTurnId: OPEN_TURN
    })
    expect(sent).toEqual([])
  })
})
