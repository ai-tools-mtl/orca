import type { RouteBypassLabelMethods } from './route-bypass-labels'
import {
  getRouteBypassLabel,
  listRouteBypassLabels,
  saveRouteBypassLabel
} from './route-bypass-labels'

/** 旁路对照标注的方法挂载（v60）：与决策审计同族，但行数预算独立于 routing-ledger。 */
export function attachRouteBypassLabels(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    saveRouteBypassLabel,
    getRouteBypassLabel,
    listRouteBypassLabels
  })
}

export type { RouteBypassLabelMethods }
