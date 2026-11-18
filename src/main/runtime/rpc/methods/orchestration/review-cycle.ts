import { defineOrchestrationMethod } from './access/orchestration-method-access'
import { coordinatedRunAccess } from './access/run-access-rules'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import {
  ReviewCycleParams,
  ReviewCycleStartParams,
  ReviewOpinionRecordParams
} from '../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'

// Plan §7 write-review pilot RPCs: the deterministic loop surface over the review-cycle store.
// Acceptance is a separate user act (orchestration.reviewCycleAccept) — never automatic.

export const ORCHESTRATION_REVIEW_CYCLE_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.reviewCycleStart',
    permission: 'workspace',
    params: ReviewCycleStartParams,
    access: {
      kind: 'writes',
      caller: 'from',
      targets: { run: 'run' },
      rule: coordinatedRunAccess
    },
    handler: (params, { runtime }) => {
      const db: OrchestrationDb = runtime.getOrchestrationDb()
      return {
        cycle: db.startReviewCycle({
          taskId: params.task,
          writerDispatchId: params.writerDispatch,
          reviewerDispatchId: params.reviewerDispatch
        })
      }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.reviewRevisionSubmit',
    permission: 'workspace',
    params: ReviewCycleParams,
    access: {
      kind: 'writes',
      caller: 'from',
      targets: { run: 'run' },
      rule: coordinatedRunAccess
    },
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      return { cycle: db.submitReviewRevision(params.cycle) }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.reviewOpinionRecord',
    permission: 'workspace',
    params: ReviewOpinionRecordParams,
    access: {
      kind: 'writes',
      caller: 'from',
      targets: { run: 'run' },
      rule: coordinatedRunAccess
    },
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      return {
        opinion: db.recordReviewOpinion({
          cycleId: params.cycle,
          body: params.body,
          ...(params.blocking !== undefined ? { blocking: params.blocking } : {})
        }),
        cycle: db.getReviewCycle(params.cycle)
      }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.reviewCycleShow',
    permission: 'workspace',
    params: ReviewCycleParams,
    access: {
      kind: 'reads',
      caller: 'from',
      targets: { run: 'run' },
      rule: coordinatedRunAccess
    },
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      return {
        cycle: db.getReviewCycle(params.cycle),
        opinions: db.listReviewOpinions(params.cycle)
      }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.reviewCycleAccept',
    permission: 'workspace',
    params: ReviewCycleParams,
    access: {
      kind: 'writes',
      caller: 'from',
      targets: { run: 'run' },
      rule: coordinatedRunAccess
    },
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      return { cycle: db.acceptReviewCycle(params.cycle) }
    }
  })
]
