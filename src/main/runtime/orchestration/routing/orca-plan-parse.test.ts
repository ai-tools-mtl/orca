import { describe, expect, it } from 'vitest'
import { parseOrcaPlan, savedOrcaPlanStages } from './orca-plan-parse'

describe('orca-plan parse (pipeline §5)', () => {
  it('extracts the fenced stages block', () => {
    const body = [
      '计划如下：',
      '```orca-plan',
      '{"stages":[{"title":"实现登录修复","agent":"codex","spec":"修复登录超时并补回归"}]}',
      '```',
      '以上。'
    ].join('\n')
    expect(parseOrcaPlan(body)).toEqual({
      status: 'ok',
      stages: [{ title: '实现登录修复', agent: 'codex', spec: '修复登录超时并补回归' }]
    })
  })

  it('reports missing for null or block-less reports — a prototype stage is not a failure', () => {
    expect(parseOrcaPlan(null)).toEqual({ status: 'missing' })
    expect(parseOrcaPlan('原型已完成，见 prototype/。')).toEqual({ status: 'missing' })
  })

  it('reports invalid for malformed JSON and schema violations, with bounds', () => {
    expect(parseOrcaPlan('```orca-plan\nnot json\n```').status).toBe('invalid')
    expect(parseOrcaPlan('```orca-plan\n{"stages":[]}\n```').status).toBe('invalid')
    expect(parseOrcaPlan('```orca-plan\n{"stages":[{"title":"","spec":"x"}]}\n```').status).toBe(
      'invalid'
    )
    const nine = Array.from({ length: 9 }, (_, index) => `{"title":"t${index}","spec":"s${index}"}`)
    expect(parseOrcaPlan(`\`\`\`orca-plan\n{"stages":[${nine.join(',')}]}\n\`\`\``).status).toBe(
      'invalid'
    )
  })

  it('reads a saved payload back; a parse-failure marker stays null', () => {
    const payload = JSON.stringify({ stages: [{ title: 't', spec: 's' }] })
    expect(savedOrcaPlanStages(payload)).toEqual([{ title: 't', spec: 's' }])
    expect(
      savedOrcaPlanStages(JSON.stringify({ parseError: '报告中没有 orca-plan 计划块' }))
    ).toBeNull()
    expect(savedOrcaPlanStages(null)).toBeNull()
  })
})
