import {
  ensureRoutingDispatchHold,
  grantRoutingDispatch,
  setRoutingDispatchAuthorized,
  setRoutingDispatchHold
} from './dispatch-authorization'

/** 派发授权的方法类型（§派发授权）——db-methods 组合引用；运行时挂载在本文件。 */
export type DispatchAuthorizationMethods = {
  setRoutingDispatchHold: typeof setRoutingDispatchHold
  setRoutingDispatchAuthorized: typeof setRoutingDispatchAuthorized
  grantRoutingDispatch: typeof grantRoutingDispatch
  ensureRoutingDispatchHold: typeof ensureRoutingDispatchHold
}

/** 派发授权的方法挂载：grant/ensure/标志写入集中在 dispatch-authorization.ts。 */
export function attachDispatchAuthorization(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    setRoutingDispatchHold,
    setRoutingDispatchAuthorized,
    grantRoutingDispatch,
    ensureRoutingDispatchHold
  })
}
