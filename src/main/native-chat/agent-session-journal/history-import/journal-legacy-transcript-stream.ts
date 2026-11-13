import { decodeClaudeTranscriptLine } from '../../transcript-decoding/transcript-line-decoders-claude'
import { decodeCodexTranscriptLine } from '../../transcript-decoding/transcript-line-decoders-codex'
import { decodeDshTranscriptLine } from '../../transcript-decoding/transcript-line-decoders-dsh'
import { decodeGrokTranscriptLine } from '../../transcript-decoding/transcript-line-decoders-grok'
import { decodeOmpTranscriptLine } from '../../transcript-decoding/transcript-line-decoders-omp'
import { createReadStream } from 'node:fs'
import { decodeTranscriptStream } from '../../transcript-streaming/transcript-stream-lines'
import { zstdTranscriptStream } from '../../transcript-streaming/transcript-zstd-decompression'
import {
  readCodexLocalHistory,
  type CodexHistoryRecord
} from '../../transcript-history/codex/codex-local-history'

const DSH_TRANSCRIPT_SUFFIX = 'session.v4.jsonl.zstd'

export async function readLegacyImportTranscript(
  input: { filePath: string; codex: boolean; roots?: readonly string[] },
  visit: (line: string, fallbackId: string, recordId?: string, selected?: boolean) => null,
  visitRecord?: (record: CodexHistoryRecord) => void
): Promise<{ consumedBytes: number }> {
  if (input.codex) {
    return {
      consumedBytes: await readCodexLocalHistory({
        ...input,
        visitRecord,
        visit: (line, fallbackId, selected, recordId) => visit(line, fallbackId, recordId, selected)
      })
    }
  }
  // dsh transcripts are zstd-compressed; every other legacy import reads plain UTF-8.
  const raw = createReadStream(input.filePath)
  const stream = input.filePath.endsWith(DSH_TRANSCRIPT_SUFFIX) ? zstdTranscriptStream(raw) : raw
  return decodeTranscriptStream(stream, input.filePath, 0, visit, true, 16 * 1024 * 1024)
}

export const TRANSCRIPT_DECODERS = {
  claude: decodeClaudeTranscriptLine,
  codex: (line: string, fallbackId: string) =>
    decodeCodexTranscriptLine(line, fallbackId, { historyImport: true }),
  dsh: decodeDshTranscriptLine,
  grok: decodeGrokTranscriptLine,
  omp: decodeOmpTranscriptLine
} as const
