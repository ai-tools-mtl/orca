import { OrchestrationError } from '../orchestration-error'
import { generateId } from '../db/generated-id'
import type { OrchestrationDb } from '../db/orchestration-db'
import type { RoutingInputRow, RoutingSubActionRow } from '../db/routing-records'

export function registerRoutingInput(
  this: OrchestrationDb,
  input: { runId: string; text: string; decision?: unknown }
): RoutingInputRow {
  this.requireRun(input.runId)
  this.db.exec('SAVEPOINT register_routing_input')
  try {
    const id = generateId('rinp')
    this.db
      .prepare(
        `INSERT INTO routing_inputs (input_id, run_id, raw_text, received_seq, decision_status, decision_json)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(received_seq), 0) + 1 FROM routing_inputs WHERE run_id = ?), 'received', NULL)`
      )
      .run(id, input.runId, input.text, input.runId)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads back exactly the row just inserted.
    const row = this.getRoutingInput(id) as RoutingInputRow
    this.db.exec('RELEASE register_routing_input')
    return row
  } catch (error) {
    this.db.exec('ROLLBACK TO register_routing_input')
    this.db.exec('RELEASE register_routing_input')
    throw error
  }
}

export function registerRoutingDecision(
  this: OrchestrationDb,
  input: {
    inputId: string
    /** One entry per sub-action, in input order; each becomes sa-{input num}-{ordinal}. */
    subActions: { text: string; constraints?: string[]; taskId?: string | null }[]
    decision?: unknown
  }
): { subActions: RoutingSubActionRow[]; reused: boolean } {
  const source = this.getRoutingInput(input.inputId)
  if (!source) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `Routing input ${input.inputId} was not found.`,
      { inputId: input.inputId }
    )
  }
  this.db.exec('SAVEPOINT register_routing_decision')
  try {
    // §5.1: one decision per input version. A re-registration after a restart reuses the
    // recorded sub-actions (same stable ids) instead of minting a second set.
    if (source.decision_status === 'decided') {
      const existing = this.listSubActions(input.inputId)
      this.db.exec('RELEASE register_routing_decision')
      return { subActions: existing, reused: true }
    }
    // The stable id's num comes from the input row's ordinal, so `sa-{num}-{k}` is globally unique.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the COUNT(*) projection is exactly { seq: number }.
    const num = this.db
      .prepare(
        'SELECT COUNT(*) AS seq FROM routing_inputs WHERE rowid <= (SELECT rowid FROM routing_inputs WHERE input_id = ?)'
      )
      .get(input.inputId) as { seq: number } | undefined
    if (!num) {
      throw new OrchestrationError(
        'lifecycle_not_found',
        `Routing input ${input.inputId} was not found while numbering sub-actions.`,
        { inputId: input.inputId }
      )
    }
    this.db
      .prepare(
        `UPDATE routing_inputs SET decision_status = 'decided', decision_json = ? WHERE input_id = ?`
      )
      .run(input.decision === undefined ? null : JSON.stringify(input.decision), input.inputId)
    const rows = input.subActions.map((subAction, index) => {
      const id = `sa-${num.seq}-${index + 1}`
      this.db
        .prepare(
          `INSERT INTO routing_sub_actions (sub_action_id, input_id, run_id, seq, text, constraints_json, task_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.inputId,
          source.run_id,
          index + 1,
          subAction.text,
          JSON.stringify(subAction.constraints ?? []),
          subAction.taskId ?? null
        )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fetch reads back exactly the row just inserted.
      return this.getSubAction(id) as RoutingSubActionRow
    })
    this.db.exec('RELEASE register_routing_decision')
    return { subActions: rows, reused: false }
  } catch (error) {
    this.db.exec('ROLLBACK TO register_routing_decision')
    this.db.exec('RELEASE register_routing_decision')
    throw error
  }
}

export function getRoutingInput(
  this: OrchestrationDb,
  inputId: string
): RoutingInputRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db.prepare('SELECT * FROM routing_inputs WHERE input_id = ?').get(inputId) as
    | RoutingInputRow
    | undefined
}
