import { z } from 'zod'
import { OptionalString, requiredString } from '../rpc-param-primitives'

export const RoutingInputRegisterParams = z.object({
  run: OptionalString,
  text: requiredString('Missing --text'),
  from: OptionalString
})

export const RoutingDecisionRegisterParams = z.object({
  input: requiredString('Missing --input'),
  /** JSON array of [{text, constraints?, task?}]; parsed before the Run is checked. */
  subActions: requiredString('Missing --sub-actions'),
  from: OptionalString,
  run: OptionalString
})

export const RoutingSupplementSendParams = z.object({
  input: requiredString('Missing --input'),
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch'),
  text: requiredString('Missing --text'),
  /** Omitted: steer the Dispatch's active turn at send time. Given: steer exactly that turn. */
  expectedTurn: OptionalString,
  from: OptionalString,
  run: OptionalString
})

export const RoutingSupplementShowParams = z.object({
  supplement: OptionalString,
  subAction: OptionalString,
  from: OptionalString,
  run: OptionalString
})

export const RoutingTargetShowParams = z.object({
  dispatch: requiredString('Missing --dispatch'),
  from: OptionalString,
  run: OptionalString
})

export const RoutingInputsShowParams = z.object({
  from: OptionalString,
  run: OptionalString
})

export const RoutingSupplementContinueParams = z.object({
  input: requiredString('Missing --input'),
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch'),
  from: OptionalString,
  run: OptionalString
})

export const RoutingContinuationBindParams = z.object({
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch'),
  from: OptionalString,
  run: OptionalString
})

export const RoutingSubActionVerifyParams = z.object({
  input: requiredString('Missing --input'),
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch'),
  expectedTurn: requiredString('Missing --expected-turn'),
  text: requiredString('Missing --text'),
  expectAction: requiredString('Missing --expect-action'),
  expectPath: OptionalString,
  /** JSON array of paths no item in the session may read. */
  forbiddenPaths: OptionalString,
  /** JSON array of projected agentSession.history items (sequence + body). */
  items: requiredString('Missing --items'),
  /** Fallback anchor when the supplement echo is not its own journal item (e.g. the last
   *  pre-delivery task action). The echo wins when present. */
  anchorSequence: z.coerce.number().int().optional(),
  from: OptionalString,
  run: OptionalString
})

export const RoutingSubActionClaimParams = z.object({
  input: requiredString('Missing --input'),
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch'),
  from: OptionalString,
  run: OptionalString
})

export const RoutingSubActionHandbackParams = z.object({
  input: requiredString('Missing --input'),
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch'),
  reason: OptionalString,
  from: OptionalString,
  run: OptionalString
})

export const RoutingAutoRouteParams = z.object({
  input: requiredString('Missing --input'),
  timeoutMs: z.coerce.number().int().positive().optional(),
  from: OptionalString,
  run: OptionalString
})

export const ReviewCycleStartParams = z.object({
  task: requiredString('Missing --task'),
  writerDispatch: requiredString('Missing --writer-dispatch'),
  reviewerDispatch: requiredString('Missing --reviewer-dispatch'),
  from: OptionalString,
  run: OptionalString
})

export const ReviewCycleParams = z.object({
  cycle: requiredString('Missing --cycle'),
  from: OptionalString,
  run: OptionalString
})

export const ReviewOpinionRecordParams = z.object({
  cycle: requiredString('Missing --cycle'),
  body: requiredString('Missing --body'),
  blocking: z.boolean().optional(),
  from: OptionalString,
  run: OptionalString
})

// The desktop 统一任务入口's own surface: the entry coordinates its Run as
// `desktop-entry:<group>`, so these name a project group instead of a Run or a caller handle.
export const EntryShowParams = z.object({
  group: requiredString('Missing --group')
})

export const EntrySubmitParams = z.object({
  group: requiredString('Missing --group'),
  text: requiredString('Missing --text')
})

export const EntrySupplementParams = z.object({
  group: requiredString('Missing --group'),
  input: requiredString('Missing --input'),
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch'),
  text: requiredString('Missing --text'),
  /** Omitted: steer the Dispatch's active turn at send time. Given: steer exactly that turn. */
  expectedTurn: OptionalString
})

export const EntryHandbackParams = z.object({
  group: requiredString('Missing --group'),
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch')
})

export const EntryPauseParams = z.object({
  group: requiredString('Missing --group')
})

export const EntryReviewParams = z.object({
  group: requiredString('Missing --group'),
  task: requiredString('Missing --task')
})

export const EntryApprovalsParams = z.object({
  group: requiredString('Missing --group')
})

export const DecisionModelParams = z.object({
  provider: z.enum(['zcode-plan', 'custom']),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  modelId: z.string().optional()
})

export const EntryAutoRouteParams = z.object({
  group: requiredString('Missing --group'),
  input: requiredString('Missing --input'),
  dispatch: z.boolean().optional(),
  /** custom: the settings-configured decision model; omitted routes on the ZCode plan credential. */
  decisionModel: DecisionModelParams.optional()
})

export const EntryPlanParams = z.object({
  group: requiredString('Missing --group'),
  input: requiredString('Missing --input'),
  subActions: z.array(z.string().trim().min(1)).min(1).max(6)
})

export const EntryAssignParams = z.object({
  group: requiredString('Missing --group'),
  input: requiredString('Missing --input'),
  subAction: requiredString('Missing --sub-action'),
  agent: requiredString('Missing --agent')
})

export const EntryWorkersParams = z.object({
  group: requiredString('Missing --group')
})

export const EntryClaimParams = z.object({
  group: requiredString('Missing --group'),
  subAction: requiredString('Missing --sub-action'),
  dispatch: requiredString('Missing --dispatch')
})
