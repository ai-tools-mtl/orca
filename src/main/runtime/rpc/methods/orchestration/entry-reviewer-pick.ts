import { readZcodeV2PlanCredential } from '../../../../zcode/zcode-v2-plan-credentials'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import {
  fetchDecisionCompletion,
  type ModelDecisionProviderConfig
} from '../../../orchestration/routing/model-decision-provider'

const REVIEW_PICK_SYSTEM_PROMPT = `You pick the reviewer for a code-review round. Reply with ONLY a JSON object:
{"agent":"<agent id>"}
Choose one reviewer agent id from the candidates, never the writer itself. Prefer a structured-session channel that can run read-only inspection.`

/** The decision model picks the reviewer (§7 pairings are its call); the fallback chain is
 *  the other structured channels, never the writer itself. Without a completion endpoint the
 *  static chain decides. */
export async function pickReviewerAgent(
  reviewModelJson: string | null | undefined,
  agents: readonly TuiAgent[],
  writerAgent: string | null | undefined
): Promise<TuiAgent | undefined> {
  const candidates = agents.filter((agent) => agent !== writerAgent)
  if (candidates.length === 0) {
    return undefined
  }
  try {
    const config = await resolveDecisionConfig(parseReviewModel(reviewModelJson))
    if (config) {
      const content = await fetchDecisionCompletion(
        config,
        REVIEW_PICK_SYSTEM_PROMPT,
        `写手通道：${writerAgent ?? '未知'}。候选审查者：${candidates.join('、')}。`
      )
      const start = content.indexOf('{')
      const end = content.lastIndexOf('}')
      if (start !== -1 && end > start) {
        const parsed: unknown = JSON.parse(content.slice(start, end + 1))
        if (
          parsed &&
          typeof parsed === 'object' &&
          'agent' in parsed &&
          typeof parsed.agent === 'string' &&
          isTuiAgent(parsed.agent.trim().toLowerCase())
        ) {
          const picked = parsed.agent.trim().toLowerCase() as TuiAgent
          if (candidates.includes(picked)) {
            return picked
          }
        }
      }
    }
  } catch {
    // Unavailable credentials or a malformed reply fall through to the static chain.
  }
  const fallbackOrder: TuiAgent[] = ['codex', 'zcode', 'claude']
  return fallbackOrder.find((agent) => candidates.includes(agent)) ?? candidates[0]
}

/** What older builds may have persisted in review_model_json (routing sources are gone; the
 *  agent-only source cannot drive a completion pick and uses the static chain). */
function parseReviewModel(raw: string | null | undefined): { source?: string } | undefined {
  if (!raw) {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (value && typeof value === 'object' && 'source' in value) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the JSON projection is exactly the checked shape.
      return value as { source?: string }
    }
  } catch {
    // A malformed review model row simply falls back to the static chain.
  }
  return undefined
}

async function resolveDecisionConfig(
  decisionModel: { source?: string } | undefined
): Promise<ModelDecisionProviderConfig | undefined> {
  if (decisionModel?.source === 'agent') {
    // The agent source cannot drive the reviewer pick here — the static chain decides.
    return undefined
  }
  const credential = await readZcodeV2PlanCredential()
  return credential.status === 'ok'
    ? { apiKey: credential.apiKey, baseUrl: credential.baseUrl, modelId: credential.modelId }
    : undefined
}

type ReviewerFinding = { body: string; blocking: boolean }

export function parseReviewOpinions(
  rawResult: string | null,
  revision: number
): ReviewerFinding[] | null {
  const body = parseWorkerReport(rawResult)?.body?.trim()
  if (!body) {
    return null
  }
  const findings: ReviewerFinding[] = []
  let passed = false
  for (const line of body
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const match = /^\[R(\d+)-\d+\]\s*(blocking|note)\s*[:：]\s*(.+)$/.exec(line)
    if (match && Number(match[1]) === revision) {
      findings.push({ blocking: match[2] === 'blocking', body: match[3].trim() })
    } else if (/^无阻塞意见[。.]?$/.test(line)) {
      passed = true
    } else if (!/^\p{L}+(?:\s+\p{L}+)*[:：]$/u.test(line)) {
      return null
    }
  }
  return passed || findings.length > 0 ? findings : null
}

export function parseWorkerReport(
  rawResult: string | null
):
  | { subject?: string; body?: string; filesModified?: string[]; reportPath?: string | null }
  | undefined {
  if (!rawResult?.startsWith('{')) {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(rawResult)
    if (
      value &&
      typeof value === 'object' &&
      'provenance' in value &&
      value.provenance === 'worker_report'
    ) {
      const record = value as Record<string, unknown>
      return {
        subject: typeof record.subject === 'string' ? record.subject : undefined,
        body: typeof record.body === 'string' ? record.body : undefined,
        filesModified: Array.isArray(record.filesModified)
          ? record.filesModified.filter((file): file is string => typeof file === 'string')
          : undefined,
        reportPath: typeof record.reportPath === 'string' ? record.reportPath : null
      }
    }
    return undefined
  } catch {
    return undefined
  }
}
