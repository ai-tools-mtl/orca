import { join } from 'node:path'
import { GENERIC_ACP_DIALECT } from '../acp/acp-dialects/acp-dialect'
import { directoryAccountBinding } from '../acp/launch/acp-account-binding'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { DSH_SESSION_HISTORY } from './dsh-session-history'

// 0.2.2-rc.1 is verified end to end; earlier 0.2 lines ship the acp profile too.
export const DSH_LAUNCH_SPEC: AcpLaunchSpec = {
  agent: 'dsh',
  command: 'dsh',
  // The terminal Command setting names dsh-tui; chats speak to the dsh CLI itself.
  ignoreAgentCommandSetting: true,
  args: () => ['--profile', 'acp'],
  env: {},
  dialect: GENERIC_ACP_DIALECT,
  // Credentials come from dsh's own store or DEEPSEEK_API_KEY; no sign-in flow exists.
  loginCommand: [],
  account: directoryAccountBinding('DSH_HOME', (homePath) => join(homePath, '.dsh')),
  installDirectories: () => [],
  // dsh neither deletes sessions nor relocates their storage, so a listing probe would
  // leave sessions behind; its chats expose the real menu through their configOptions.
  modelDiscovery: { kind: 'unavailable', reason: 'dsh lists its models only in chats' },
  resumePreference: 'resume',
  transcriptImport: null,
  sessionHistory: DSH_SESSION_HISTORY
}
