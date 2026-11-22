import type { PreloadApi } from '../../../../../preload/api-types'
import {
  normalizeDecisionModelSettings,
  normalizeRouteBypassSettings
} from '../../../../../shared/settings/decision-model-settings'
import {
  DecisionModelPatchParams,
  RouteBypassPatchParams
} from '../../../../../shared/rpc-contract/orchestration/orchestration-routing-params'
import { legacyMatchTerminalSidebarWrite } from '../../../../../shared/plugins/appearance/plugin-theme-settings'
import {
  computerAwakeSettingsForMode,
  normalizeComputerAwakeMode
} from '../../../../../shared/app-lifecycle/computer-awake-mode'
import { normalizeTerminalCursorStyleDefault } from '../../../../../shared/terminal/appearance/terminal-cursor-style-settings'
import { mergeSettings, stripRetiredWebChatSettings } from './web-preference-normalization'
import {
  getRuntimeBackedStoredSettings,
  getStoredSettings,
  settingsForActiveVisibilityOwner,
  syncRuntimeBackedSettings,
  updateRuntimePRBotAuthorOverride,
  writeStoredSettings,
  type WebSettingsApi
} from './web-preferences-store'

import {
  requireActiveEnvironmentOrNull,
  resolveEnvironment,
  webRuntimeState
} from '../../runtime/client/web-runtime-session'
import { noopUnsubscribe } from '../web-storage'

export function createWebSettingsApi(): Pick<Partial<PreloadApi>, 'agentAwake'> & {
  settings: Partial<WebSettingsApi>
} {
  return {
    settings: {
      get: async () => getRuntimeBackedStoredSettings(),
      // Why: localStorage-backed settings are synchronous, so the pre-hydration kill-switch read works the same as desktop.
      getSync: () => settingsForActiveVisibilityOwner(getStoredSettings()),
      set: async ({ decisionModelPatch, routeBypassPatch, ...updates }) => {
        const sanitizedUpdates = stripRetiredWebChatSettings(updates)
        const runtimeEnvironment = requireActiveEnvironmentOrNull()
        delete sanitizedUpdates.activeRuntimeEnvironmentId
        if (
          'worktreeVisibilityDefaults' in sanitizedUpdates &&
          runtimeEnvironment &&
          runtimeEnvironment.id !== webRuntimeState.worktreeVisibilityDefaultsRuntimeEnvironmentId
        ) {
          delete sanitizedUpdates.worktreeVisibilityDefaults
        }
        if ('worktreeVisibilityDefaults' in sanitizedUpdates) {
          sanitizedUpdates.worktreeVisibilityDefaults = {
            ...settingsForActiveVisibilityOwner(getStoredSettings()).worktreeVisibilityDefaults,
            ...sanitizedUpdates.worktreeVisibilityDefaults
          }
        }
        if ('computerAwakeMode' in sanitizedUpdates) {
          Object.assign(
            sanitizedUpdates,
            computerAwakeSettingsForMode(
              normalizeComputerAwakeMode(
                sanitizedUpdates.computerAwakeMode,
                sanitizedUpdates.keepComputerAwakeWhileAgentsRun
              )
            )
          )
        } else if ('keepComputerAwakeWhileAgentsRun' in sanitizedUpdates) {
          Object.assign(
            sanitizedUpdates,
            computerAwakeSettingsForMode(
              sanitizedUpdates.keepComputerAwakeWhileAgentsRun ? 'auto' : 'off'
            )
          )
        }
        if ('autoRenameBranchFromWorkDefaultedOn' in sanitizedUpdates) {
          sanitizedUpdates.autoRenameBranchFromWorkDefaultedOn = true
        }
        if ('terminalCursorStyle' in sanitizedUpdates) {
          Object.assign(
            sanitizedUpdates,
            normalizeTerminalCursorStyleDefault(
              { terminalCursorStyle: sanitizedUpdates.terminalCursorStyle },
              { preserveExplicitValue: true }
            )
          )
        }
        const stored = getStoredSettings()
        if (decisionModelPatch !== undefined) {
          if (Object.keys(updates).length > 0) {
            throw new Error('Decision settings must be saved separately.')
          }
          sanitizedUpdates.decisionModel = normalizeDecisionModelSettings(
            DecisionModelPatchParams.parse(decisionModelPatch)
          )
        }
        if (routeBypassPatch !== undefined) {
          if (Object.keys(updates).length > 0) {
            throw new Error('Route bypass settings must be saved separately.')
          }
          sanitizedUpdates.routeBypass = normalizeRouteBypassSettings(
            RouteBypassPatchParams.parse(routeBypassPatch)
          )
        }
        Object.assign(sanitizedUpdates, legacyMatchTerminalSidebarWrite(stored, sanitizedUpdates))
        const localUpdates = { ...sanitizedUpdates }
        delete localUpdates.nativeChatAutoContinueAfterUsageLimit
        if (runtimeEnvironment) {
          delete localUpdates.worktreeVisibilityDefaults
        }
        const next = mergeSettings(stored, localUpdates, {
          preserveAutoRenameBranchFromWorkUpdate: 'autoRenameBranchFromWork' in sanitizedUpdates
        })
        writeStoredSettings(next)
        return settingsForActiveVisibilityOwner(await syncRuntimeBackedSettings(sanitizedUpdates))
      },
      setActiveRuntimeEnvironmentPreference: async ({ environmentId }) => {
        const requestedEnvironmentId = environmentId?.trim() || null
        const activeRuntimeEnvironmentId = requestedEnvironmentId
          ? resolveEnvironment(requestedEnvironmentId).id
          : null
        const next = mergeSettings(getStoredSettings(), {
          activeRuntimeEnvironmentId
        })
        writeStoredSettings(next, activeRuntimeEnvironmentId)
        return next
      },
      updatePRBotAuthorOverride: (args) => updateRuntimePRBotAuthorOverride(args),
      listFonts: () => Promise.resolve([]),
      onChanged: () => noopUnsubscribe
    },
    agentAwake: {
      getStatus: async () => {
        const settings = getStoredSettings()
        return {
          mode: normalizeComputerAwakeMode(
            settings.computerAwakeMode,
            settings.keepComputerAwakeWhileAgentsRun
          ),
          active: false
        }
      },
      onChanged: () => noopUnsubscribe
    }
  }
}
