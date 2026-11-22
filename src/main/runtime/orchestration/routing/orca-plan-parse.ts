import { z } from 'zod'

// 阶段化生命周期 (entry-stage-pipeline-plan §5): the plan agent reports its implementation plan
// as a fenced ```orca-plan JSON block — the same report-embedded protocol the review opinions
// use. Parsing is pure; callers pass the worker report's body text.

export type OrcaPlanStage = { title: string; spec: string; agent?: string; checkpoint?: boolean }

export type OrcaPlanParse =
  | { status: 'ok'; stages: OrcaPlanStage[] }
  | { status: 'missing' }
  | { status: 'invalid'; detail: string }

const ORCA_PLAN_FENCE = /```orca-plan\s*\n([\s\S]*?)```/

const orcaPlanSchema = z.object({
  stages: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        spec: z.string().trim().min(1),
        agent: z.string().trim().optional(),
        // 该阶段完成后把链条的累积产出合并进主分支（系统铸 merge 检查点行，用户确认后执行）。
        checkpoint: z.boolean().optional()
      })
    )
    .min(1)
    .max(8)
})

/** Parse the plan payload out of a worker's report body. `missing` = no block (a prototype
 *  stage's normal shape), `invalid` = a block that failed schema — both stay unexpanded. */
export function parseOrcaPlan(reportBody: string | null): OrcaPlanParse {
  const match = reportBody ? ORCA_PLAN_FENCE.exec(reportBody) : null
  if (!match?.[1]) {
    return { status: 'missing' }
  }
  let raw: unknown
  try {
    const fenced = match[1]
    const start = fenced.indexOf('{')
    const end = fenced.lastIndexOf('}')
    raw = JSON.parse(fenced.slice(start, end + 1))
  } catch (error) {
    return {
      status: 'invalid',
      detail: `orca-plan 块不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
    }
  }
  const parsed = orcaPlanSchema.safeParse(raw)
  if (!parsed.success) {
    return { status: 'invalid', detail: `orca-plan 结构不合格：${parsed.error.issues[0]?.message}` }
  }
  return { status: 'ok', stages: parsed.data.stages }
}

const orcaPlanParseErrorSchema = z.object({ parseError: z.string() })

/** Read a saved plan's parse-failure marker ({"parseError":…}) back — null while usable. */
export function savedOrcaPlanParseError(planJson: string | null): string | null {
  if (!planJson) {
    return null
  }
  try {
    const parsed = orcaPlanParseErrorSchema.safeParse(JSON.parse(planJson))
    return parsed.success ? parsed.data.parseError : null
  } catch {
    return null
  }
}

/** Read a saved plan payload back ({"stages":[…]}) — null while absent or parse-failed. */
export function savedOrcaPlanStages(planJson: string | null): OrcaPlanStage[] | null {
  if (!planJson) {
    return null
  }
  try {
    const parsed = orcaPlanSchema.safeParse(JSON.parse(planJson))
    return parsed.success ? parsed.data.stages : null
  } catch {
    return null
  }
}

const PLAN_FILE_SUFFIX = /\.(?:md|markdown|txt)$/i
const REPORT_PATH_TOKEN = /[\w@~][\w./\\-]*\.(?:md|markdown|txt)/gi

/** Workspace files worth probing for an orca-plan fence: the report's modified markdown/text
 *  files plus path-like tokens mentioned in the body. Workers sometimes save the plan to a
 *  file and only reference it in the report text (pipeline §5 recovery). */
export function candidateOrcaPlanReportFiles(
  body: string | undefined,
  filesModified: string[] | undefined
): string[] {
  const candidates: string[] = []
  for (const file of filesModified ?? []) {
    if (PLAN_FILE_SUFFIX.test(file)) {
      candidates.push(file)
    }
  }
  for (const token of body?.match(REPORT_PATH_TOKEN) ?? []) {
    candidates.push(token.replace(/[.,;:、）)]+$/, ''))
  }
  return [...new Set(candidates)].slice(0, 5)
}
