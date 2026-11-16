import { basename } from 'node:path'
import { resolveDshSessionsDir } from '../../../../shared/dsh-session-paths'
import type { AiVaultAgentSource } from '../../discovery/session-scanner-agent-sources'
import { sessionRootDirs } from '../../discovery/session-scanner-roots'
import { DSH_SESSION_TRANSCRIPT_FILE } from './session-scanner-dsh-parser'

export const DSH_AGENT_SOURCE: AiVaultAgentSource = {
  rootDirs: (options, wslHomeDirs) =>
    sessionRootDirs(options.dshSessionsDir ?? resolveDshSessionsDir(), wslHomeDirs, [
      '.dsh',
      'sessions'
    ]),
  extensions: ['.zstd'],
  // One compressed transcript per session directory; sibling files are dsh-internal state.
  filePredicate: (filePath) => basename(filePath) === DSH_SESSION_TRANSCRIPT_FILE
}
