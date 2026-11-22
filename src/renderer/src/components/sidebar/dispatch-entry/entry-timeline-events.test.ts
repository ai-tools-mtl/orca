import { expect, it } from 'vitest'
import type { RoutingEntryInput } from '../workspace-card/activity/routing-entry-model'
import {
  entryTimelineDaysOf,
  entryTimelineEventsOf,
  startOfEntryDay
} from './entry-timeline-events'

it('keeps an answered question on the day it was asked and a later result on its completion day', () => {
  const submitted = new Date(2026, 10, 16, 9)
  const asked = new Date(2026, 10, 17, 20)
  const answered = new Date(2026, 10, 22, 9)
  const completed = new Date(2026, 10, 22, 13)
  const inputs: RoutingEntryInput[] = [
    {
      inputId: 'request',
      text: 'Build an inventory browser',
      decisionStatus: 'decided',
      receivedAt: submitted.toISOString(),
      subActions: [
        {
          subActionId: 'task',
          text: 'Confirm inventory rules',
          state: 'processed',
          deliveries: [],
          answeredAsks: [
            {
              messageId: 'question',
              question: 'Allow negative stock?',
              answer: 'Reject negative stock.',
              createdAt: asked.toISOString(),
              answeredAt: answered.toISOString()
            }
          ],
          execution: {
            status: 'completed',
            agent: 'codex',
            dispatchId: 'dispatch',
            result: 'Inventory rules confirmed.',
            failure: null,
            completedAt: completed.toISOString()
          }
        }
      ]
    }
  ]

  const days = entryTimelineDaysOf(
    entryTimelineEventsOf(inputs, []),
    startOfEntryDay(completed),
    'en'
  )
  expect(days.map((day) => [day.isArchived, day.isToday, day.rows.map((row) => row.id)])).toEqual([
    [true, false, ['entry-request-request']],
    [true, false, ['entry-ask-question']],
    [false, true, ['entry-result-task']]
  ])
  expect(days[1].rows[0]).toMatchObject({ ask: { answer: 'Reject negative stock.' } })
})
