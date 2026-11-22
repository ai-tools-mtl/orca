import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import type { Store } from '../../persistence/loading-store/store'
import {
  normalizeDecisionModelSettings,
  normalizeRouteBypassSettings
} from '../../../shared/settings/decision-model-settings'
import {
  DecisionModelPatchParams,
  RouteBypassPatchParams
} from '../../../shared/rpc-contract/orchestration/orchestration-routing-params'
import { normalizeTerminalCustomThemes } from '../../../shared/terminal-themes/terminal-custom-themes'
import { normalizeDesktopTerminalScrollbackRows } from '../../../shared/terminal/replay/terminal-scrollback-policy'
import { normalizeTerminalLineHeight } from '../../../shared/terminal/appearance/terminal-line-height-settings'
import {
  NEW_TAB_MENU_LAYOUT_SETTING,
  normalizeNewTabMenuLayout
} from '../../../shared/new-tab-menu/new-tab-menu-layout'

export type RendererSettingsUpdate = Partial<GlobalSettings> & {
  decisionModelPatch?: unknown
  routeBypassPatch?: unknown
}

export function saveRendererDecisionModelPatch(
  store: Pick<Store, 'updateSettingsAndFlush'>,
  updates: RendererSettingsUpdate,
  originWebContentsId: number
): Promise<GlobalSettings> {
  if (Object.keys(updates).length !== 1) {
    throw new Error('Decision settings must be saved separately.')
  }
  const decisionModel = normalizeDecisionModelSettings(
    DecisionModelPatchParams.parse(updates.decisionModelPatch)
  )
  return store.updateSettingsAndFlush(() => ({ decisionModel }), {
    notifyListeners: true,
    originWebContentsId
  })
}

/** 专用决策模型旁路对照配置（评估）：单键单独保存，key 不回显。 */
export function saveRendererRouteBypassPatch(
  store: Pick<Store, 'updateSettingsAndFlush'>,
  updates: RendererSettingsUpdate,
  originWebContentsId: number
): Promise<GlobalSettings> {
  if (Object.keys(updates).length !== 1) {
    throw new Error('Route bypass settings must be saved separately.')
  }
  const routeBypass = normalizeRouteBypassSettings(
    RouteBypassPatchParams.parse(updates.routeBypassPatch)
  )
  return store.updateSettingsAndFlush(() => ({ routeBypass }), {
    notifyListeners: true,
    originWebContentsId
  })
}

type LegacyTerminalScrollbackSettingsUpdate = Partial<GlobalSettings> & {
  terminalScrollbackBytes?: unknown
}

export function sanitizeRendererSettingsUpdate(
  args: Partial<GlobalSettings>
): Partial<GlobalSettings> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This legacy field is removed before the typed update is returned.
  const { terminalScrollbackBytes: _legacyScrollbackBytes, ...sanitizedArgs } =
    args as LegacyTerminalScrollbackSettingsUpdate
  void _legacyScrollbackBytes
  // Plugin consent and enablement require main's reviewed-fingerprint handlers.
  // Account configuration must stop old writers and commit through the host account operation.
  delete sanitizedArgs.antigravityChatAuth
  delete sanitizedArgs.pluginConsents
  delete sanitizedArgs.disabledPlugins
  delete sanitizedArgs.pluginExternalHostGrants
  // Only main's assignment writes this; other telemetry fields keep their existing handling.
  if (sanitizedArgs.telemetry && 'browserExtensionsBanner' in sanitizedArgs.telemetry) {
    const { browserExtensionsBanner: _mainOwned, ...telemetry } = sanitizedArgs.telemetry
    void _mainOwned
    sanitizedArgs.telemetry = telemetry
  }
  if (
    'browserPasswordsFillRequiresReauth' in sanitizedArgs &&
    typeof sanitizedArgs.browserPasswordsFillRequiresReauth !== 'boolean'
  ) {
    delete sanitizedArgs.browserPasswordsFillRequiresReauth
  }
  for (const key of Object.values(NEW_TAB_MENU_LAYOUT_SETTING)) {
    if (key in sanitizedArgs) {
      sanitizedArgs[key] = normalizeNewTabMenuLayout(sanitizedArgs[key])
    }
  }
  if ('terminalCustomThemes' in args) {
    sanitizedArgs.terminalCustomThemes = normalizeTerminalCustomThemes(args.terminalCustomThemes)
  }
  if ('terminalScrollbackRows' in args) {
    sanitizedArgs.terminalScrollbackRows = normalizeDesktopTerminalScrollbackRows(
      args.terminalScrollbackRows
    )
  }
  if ('terminalLineHeight' in args) {
    sanitizedArgs.terminalLineHeight = normalizeTerminalLineHeight(args.terminalLineHeight)
  }
  return sanitizedArgs
}
