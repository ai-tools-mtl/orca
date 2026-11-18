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
