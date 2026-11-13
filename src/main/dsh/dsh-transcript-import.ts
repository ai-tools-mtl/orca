import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DSH_SESSION_TRANSCRIPT_FILE } from '../ai-vault/scanners/dsh/session-scanner-dsh-parser'
import { resolveDshHomeDir } from '../../shared/dsh-session-paths'
import { directoryTranscriptImport } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'

// Real stores wrap the encoded cwd on both ends: /tmp/dsh-probe → --tmp-dsh-probe--.
function dshEncodedCwdBucket(cwd: string): string {
  const encoded = cwd
    .trim()
    .replace(/^[/\\]+/, '')
    .replace(/[/\\:]+/g, '-')
  return encoded ? `--${encoded}--` : ''
}

async function isDshSessionTranscript(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Bucket walk bound so a corrupt or enormous store cannot stall adoption. */
const DSH_BUCKET_SCAN_MAX_ENTRIES = 2_048

/** Session ids are UUIDs; they become path segments, so never accept other shapes. */
function isSafeDshSessionId(providerSessionId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(providerSessionId)
}

/** ID-only lookup across every cwd bucket; adoption prefers its cwd-keyed direct hit first. */
export async function findDshSessionTranscriptById(
  store: string,
  providerSessionId: string
): Promise<string | null> {
  if (!isSafeDshSessionId(providerSessionId)) {
    return null
  }
  return findDshSessionInAnyBucket(store, providerSessionId)
}

async function findDshSessionInAnyBucket(
  store: string,
  providerSessionId: string
): Promise<string | null> {
  let buckets
  try {
    buckets = await readdir(store, { withFileTypes: true })
  } catch {
    return null
  }
  let scanned = 0
  for (const bucket of buckets) {
    if (!bucket.isDirectory() || bucket.isSymbolicLink()) {
      continue
    }
    scanned += 1
    if (scanned > DSH_BUCKET_SCAN_MAX_ENTRIES) {
      return null
    }
    const transcript = join(store, bucket.name, providerSessionId, DSH_SESSION_TRANSCRIPT_FILE)
    if (await isDshSessionTranscript(transcript)) {
      return transcript
    }
  }
  return null
}

export const DSH_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  conversationStore: ({ accountHomePath }) => join(accountHomePath, 'sessions'),
  // The chat's own home, then the one Session History lists dsh's conversations from.
  accountHomeCandidates: ({ selectedAccountHomePath }) => [
    selectedAccountHomePath,
    resolveDshHomeDir()
  ],
  findTranscript: async ({ providerSessionId, store, workspaceCwd }) => {
    if (!isSafeDshSessionId(providerSessionId)) {
      return null
    }
    const bucket = dshEncodedCwdBucket(workspaceCwd)
    const direct = bucket
      ? join(store, bucket, providerSessionId, DSH_SESSION_TRANSCRIPT_FILE)
      : null
    if (direct && (await isDshSessionTranscript(direct))) {
      return direct
    }
    // Path spellings drift (/private/tmp vs /tmp), so fall back to a bounded bucket walk.
    return findDshSessionInAnyBucket(store, providerSessionId)
  }
})
