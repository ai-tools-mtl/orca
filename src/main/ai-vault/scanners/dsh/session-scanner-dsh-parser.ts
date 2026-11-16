import { createZstdDecompress } from 'node:zlib'
import { createInterface } from 'node:readline'
import { dirname } from 'node:path'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { openTranscriptReadStream } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-error'
import {
  throwIfAiVaultScanCancelled,
  waitForAiVaultScan
} from '../../scan-lifecycle/ai-vault-scan-cancellation'
import {
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from '../../parsing/session-scanner-accumulator'
import { addSessionContent } from '../../parsing/session-scanner-messages'
import { asRecord } from '../../parsing/session-record-fields'
import { extractString } from '../../../../shared/text/trimmed-string'
import { parseJsonObject } from '../../parsing/session-json-object'
import { normalizeTitleText } from '../../parsing/session-scanner-text-normalization'
import { numberValue } from '../../parsing/session-scanner-token-values'
import type { FileWithMtime, SessionAccumulator } from '../../session-scanner-types'
import type { TranscriptMessageSink } from '../../transcripts/session-transcript-consumers'
import {
  MAX_SESSION_TRANSCRIPT_RECORD_BYTES,
  type SkippedTranscriptRecord
} from '../../transcripts/session-transcript-record-budget'

export const DSH_SESSION_TRANSCRIPT_FILE = 'session.v4.jsonl.zstd'

export async function parseDshSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink,
  signal?: AbortSignal,
  onSkippedRecords?: (records: SkippedTranscriptRecord[]) => void
): Promise<AiVaultSession | null> {
  const accumulator = createAccumulator({
    agent: 'dsh',
    file,
    sessionId: sessionIdFromFileName(dirname(file.path)),
    messages
  })
  const skipped: SkippedTranscriptRecord[] = []
  await consumeDshSessionLog(accumulator, file.path, signal, skipped)
  onSkippedRecords?.(skipped)
  return finalizeSession(accumulator, platform)
}

/** Decoded record offsets identity skipped records across reparse; newlines are excluded. */
async function consumeDshSessionLog(
  accumulator: SessionAccumulator,
  transcriptPath: string,
  signal?: AbortSignal,
  skipped: SkippedTranscriptRecord[] = []
): Promise<void> {
  const compressed = openTranscriptReadStream(transcriptPath, {}, 'scan', signal)
  const decoder = createZstdDecompress()
  compressed.on('error', (error) => decoder.destroy(error))
  compressed.pipe(decoder)
  const lines = createInterface({ input: decoder, crlfDelay: Infinity })
  let byteOffset = 0
  try {
    for await (const line of lines) {
      await waitForAiVaultScan(accumulator.messages.drain?.() ?? Promise.resolve(), signal)
      const approximateBytes = Buffer.byteLength(line, 'utf8')
      if (approximateBytes > MAX_SESSION_TRANSCRIPT_RECORD_BYTES) {
        skipped.push({ byteOffset, approximateBytes })
        byteOffset += approximateBytes + 1
        continue
      }
      byteOffset += approximateBytes + 1
      applyDshSessionRecord(accumulator, parseJsonObject(line))
    }
  } catch (error) {
    throwIfAiVaultScanCancelled(signal)
    // A corrupt transcript still lists its partial session; WSL refusal must propagate so
    // incomplete history is not cached as current.
    if (
      error instanceof WslTranscriptFsError ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error
    }
  } finally {
    // readline.close() leaves its input open; destroy the gated stream after read failures too.
    lines.close()
    compressed.destroy()
    decoder.destroy()
  }
}

function applyDshSessionRecord(
  accumulator: SessionAccumulator,
  record: Record<string, unknown> | null
): void {
  if (!record) {
    return
  }
  const type = extractString(record.type)
  const time = numberValue(record.time)
  const data = asRecord(record.data)
  switch (type) {
    case 'session':
      accumulator.sessionId = extractString(record.id) ?? accumulator.sessionId
      accumulator.cwd ??= extractString(record.cwd)
      break
    case 'session/title':
      accumulator.title ??= normalizeTitleText(extractString(data?.title) ?? '')
      break
    case 'model/selection':
      accumulator.model ??= extractString(data?.model)
      break
    case 'user/message': {
      // Only direct human prompts count; runtime-context and skill-catalog rows are injections.
      if (extractString(asRecord(data?.source)?.kind) !== 'user') {
        break
      }
      addSessionContent(accumulator, 'user', data?.content, time)
      accumulator.messageCount++
      break
    }
    case 'assistant/message': {
      addSessionContent(accumulator, 'assistant', asRecord(data?.message)?.content, time)
      accumulator.messageCount++
      accumulator.totalTokens += numberValue(asRecord(data?.usage)?.totalTokens) ?? 0
      break
    }
    default:
      break
  }
  if (time !== undefined) {
    updateTimeline(accumulator, time)
  }
}
