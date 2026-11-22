import type { RpcContext } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

export function requireEntryPerson(ctx: RpcContext): void {
  if (ctx.caller?.kind !== 'desktop' || ctx.plugin || ctx.orchestrationCaller) {
    throw new OrchestrationError(
      'approval_requires_person',
      'Confirm this task from the Orca desktop.'
    )
  }
}
