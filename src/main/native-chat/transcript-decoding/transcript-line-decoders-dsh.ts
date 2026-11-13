import type {
  NativeChatBlock,
  NativeChatMessage
} from '../../../shared/native-chat/native-chat-types'
import type { AgentSessionTokenUsage } from '../../../shared/agent-session/agent-session-context-usage'
import { asRecord } from '../../ai-vault/parsing/session-record-fields'
import { extractString } from '../../../shared/trimmed-string'
import { parseJsonObject } from '../../ai-vault/parsing/session-json-object'
import { timestampMs } from '../../ai-vault/parsing/session-record-time'

// dsh writes session.v4.jsonl.zstd; the import stream decompresses before this decoder sees lines.

export function decodeDshTranscriptLine(
  line: string,
  fallbackId: string
): NativeChatMessage | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  const type = extractString(record.type)
  const data = asRecord(record.data)
  const timestamp = parseTimestamp(record.time)
  if (type === 'user/message') {
    // runtime-context and skill-catalog rows are harness injections, not user prompts.
    if (extractString(asRecord(data?.source)?.kind) !== 'user') {
      return null
    }
    return textMessage({
      id: recordId(data?.id, fallbackId),
      role: 'user',
      content: data?.content,
      timestamp
    })
  }
  if (type === 'assistant/message') {
    const message = asRecord(data?.message)
    const content = message?.content
    const blocks = dshTextBlocks(content)
    if (blocks.length === 0) {
      return null
    }
    const model = extractString(asRecord(message?.source)?.model)
    const usage = dshTokenUsage(asRecord(data?.usage))
    return {
      id: recordId(message?.id ?? data?.id, fallbackId),
      role: 'assistant',
      blocks,
      timestamp,
      source: 'transcript',
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {})
    }
  }
  if (type === 'tool/call') {
    const name = extractString(data?.name) ?? 'tool'
    let input: unknown = data?.arguments
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input)
      } catch {
        // Keep the raw string; bounded like every other decoder input.
      }
    }
    return {
      id: recordId(data?.callId, fallbackId),
      role: 'tool',
      blocks: [{ type: 'tool-call', name, input, ...callId(data?.callId) }],
      timestamp,
      source: 'transcript'
    }
  }
  if (type === 'tool/result') {
    const message = asRecord(data?.message)
    const output = dshToolResultOutput(message?.content)
    return {
      id: recordId(message?.toolCallId ?? data?.callId, fallbackId),
      role: 'tool',
      blocks: [{ type: 'tool-result', output, ...callId(message?.toolCallId ?? data?.callId) }],
      timestamp,
      source: 'transcript'
    }
  }
  return null
}

function recordId(value: unknown, fallbackId: string): string {
  const id = extractString(value)
  return id ? `${fallbackId}:${id}` : fallbackId
}

function callId(value: unknown): { callId: string } | Record<string, never> {
  const id = extractString(value)
  return id ? { callId: id } : {}
}

function textMessage(args: {
  id: string
  role: 'user'
  content: unknown
  timestamp: number | null
}): NativeChatMessage | null {
  const blocks = dshTextBlocks(args.content)
  return blocks.length === 0
    ? null
    : { id: args.id, role: args.role, blocks, timestamp: args.timestamp, source: 'transcript' }
}

/** Text blocks only: reasoning carries no display text, and tool blocks arrive as their own records. */
function dshTextBlocks(content: unknown): NativeChatBlock[] {
  if (!Array.isArray(content)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const item of content) {
    const text = extractString(asRecord(item)?.text)
    if (text && asRecord(item)?.type === 'text') {
      blocks.push({ type: 'text', text })
    }
  }
  return blocks
}

function dshToolResultOutput(content: unknown): string {
  if (!Array.isArray(content)) {
    return ''
  }
  const parts: string[] = []
  for (const item of content) {
    const text = extractString(asRecord(item)?.text)
    if (text) {
      parts.push(text)
    }
  }
  return parts.join('\n')
}

function dshTokenUsage(usage: Record<string, unknown> | null): AgentSessionTokenUsage | null {
  if (!usage) {
    return null
  }
  return {
    inputTokens: tokenCount(usage.inputTokens),
    cacheCreationInputTokens: tokenCount(usage.cacheWriteTokens),
    cacheReadInputTokens: tokenCount(usage.cacheReadTokens),
    outputTokens: tokenCount(usage.outputTokens)
  }
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function parseTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
