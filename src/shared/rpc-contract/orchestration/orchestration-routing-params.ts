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
