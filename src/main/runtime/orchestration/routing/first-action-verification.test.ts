import { describe, it, expect } from 'vitest'
import {
  verifySupplementFirstAction,
  type RoutingConversationItem
} from './first-action-verification'

const turn = (sequence: number, turnId: string): RoutingConversationItem => ({
  sequence,
  body: { kind: 'turn', turnId }
})
const echo = (sequence: number, text: string): RoutingConversationItem => ({
  sequence,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
})
const read = (sequence: number, path: string): RoutingConversationItem => ({
  sequence,
  body: { kind: 'tool-call', name: 'read', input: { path } }
})

const expectation = (over: Partial<Parameters<typeof verifySupplementFirstAction>[1]>) => ({
  afterSequence: 2,
  expect: { actionName: 'read', inputPath: '/w/new.txt' },
  ...over
})

describe('verifySupplementFirstAction turn scoping', () => {
  it('complies when the echo and the first read land in the expected turn', () => {
    const items = [turn(1, 't1'), echo(2, '只读 new.txt'), read(3, '/w/new.txt')]
    const verdict = verifySupplementFirstAction(items, expectation({ expectedTurnId: 't1' }))
    expect(verdict.verdict).toBe('complied')
  })

  it('violates when the echo lands in a different turn than the steered one', () => {
    const items = [turn(1, 't1'), turn(2, 't2'), echo(3, '只读 new.txt'), read(4, '/w/new.txt')]
    const verdict = verifySupplementFirstAction(
      items,
      expectation({ afterSequence: 3, expectedTurnId: 't1' })
    )
    expect(verdict.verdict).toBe('violated')
    expect(verdict.verdict === 'violated' && verdict.reason).toMatch(/landed in turn t2/)
  })

  it('does not credit another turn’s action as the expected turn’s first action', () => {
    const items = [turn(1, 't1'), echo(2, '只读 new.txt'), turn(3, 't2'), read(4, '/w/new.txt')]
    const verdict = verifySupplementFirstAction(items, expectation({ expectedTurnId: 't1' }))
    expect(verdict.verdict).toBe('pending')
  })

  it('keeps the session-wide scan when no expected turn is pinned', () => {
    const items = [turn(1, 't1'), echo(2, '只读 new.txt'), turn(3, 't2'), read(4, '/w/new.txt')]
    const verdict = verifySupplementFirstAction(items, expectation({}))
    expect(verdict.verdict).toBe('complied')
  })

  it('still reports a forbidden read anywhere in the session', () => {
    const items = [
      turn(1, 't1'),
      echo(2, '只读 new.txt'),
      read(3, '/w/new.txt'),
      turn(4, 't2'),
      read(5, '/w/old.txt')
    ]
    const verdict = verifySupplementFirstAction(
      items,
      expectation({ expectedTurnId: 't1', forbiddenPaths: ['/w/old.txt'] })
    )
    expect(verdict.verdict).toBe('violated')
    expect(verdict.verdict === 'violated' && verdict.reason).toMatch(/forbidden path/)
  })
})
