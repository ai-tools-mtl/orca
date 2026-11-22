#!/opt/homebrew/Cellar/node/26.12.0/bin/node
/** Deterministic codex app-server stand-in for the 阶段化生命周期 P0 (entry-stage-pipeline-plan §11).
 *  Same wire protocol as the routing-P0 fake; the scenario comes from the task text:
 *  - 原型设计: extracts the requirement MARKER, writes prototype-note.txt (marker + cwd) in its
 *    worktree, reports without an orca-plan block.
 *  - 任务设计与拆解: reads prototype-note.txt (same-tree proof), reports the note plus a
 *    `上游交接标记 PLAN-<marker>` line and an orca-plan block with one implement stage.
 *  - 实现设置页: reads prototype-note.txt, writes pipeline-proof.txt, reports whether the
 *    injected upstream report carried the PLAN- marker, and both files' contents.
 *  Every turn ends with worker_done through the `orca` CLI shim on PATH. */

import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

import { createInterface } from 'node:readline'

const trace = process.env.FAKE_CODEX_TRACE
  ? (line) => appendFileSync(process.env.FAKE_CODEX_TRACE, `${Date.now()} ${line}\n`)
  : () => {}

const THREAD_ID = 'fake-thread-1'
const THREAD_PATH = '/fake/rollout.jsonl'

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.164.0\n')
  process.exit(0)
}

let nextTurn = 0
let workerDoneSent = false

trace(`started argv=${process.argv.join(' ')} cwd=${process.cwd()}`)
const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)
const respond = (id, result) => write({ id, result })
const notify = (method, params) => write({ method, params })

function parsePreamble(text) {
  const taskId = text.match(/Your task ID is:\s*(\S+)/)?.[1] ?? null
  const dispatchId = text.match(/--dispatch-id\s+(\S+)/)?.[1] ?? null
  const workerHandle = text.match(/--from\s+(\S+)\s+--type worker_done/)?.[1] ?? null
  return { taskId, dispatchId, workerHandle }
}

function reportWorkerDone(identity, body) {
  if (workerDoneSent || !identity.workerHandle || !identity.taskId || !identity.dispatchId) {
    return
  }
  workerDoneSent = true
  const child = spawn(
    'orca',
    [
      'orchestration',
      'send',
      '--from',
      identity.workerHandle,
      '--type',
      'worker_done',
      '--subject',
      '阶段任务完成',
      '--body',
      body,
      '--task-id',
      identity.taskId,
      '--dispatch-id',
      identity.dispatchId,
      '--outcome',
      'succeeded',
      '--json'
    ],
    { stdio: 'ignore', env: process.env }
  )
  child.on('error', (error) => trace(`worker_done spawn error: ${String(error)}`))
  child.on('spawn', () => trace(`worker_done spawned pid=${child.pid}`))
}

function emitAgentMessage(turnId, text, id) {
  const item = { type: 'agentMessage', id }
  notify('item/started', { threadId: THREAD_ID, turn: { id: turnId }, item })
  const completed = { ...item, text }
  notify('item/completed', { threadId: THREAD_ID, turn: { id: turnId }, item: completed })
}

function completeTurn(turnId) {
  notify('turn/completed', { threadId: THREAD_ID, turn: { id: turnId, status: 'completed' } })
}

function requirementMarker(text) {
  return text.match(/MARKER-[A-Za-z0-9-]+/)?.[0] ?? 'MARKER-none'
}

function runStageTask(turnId, text) {
  trace(`stage task turn=${turnId} preamble-parsed=${JSON.stringify(parsePreamble(text))}`)
  trace(`stage task text=${text.slice(0, 600).replace(/\n/g, '\\n')}`)
  const cwd = process.cwd()
  const marker = requirementMarker(text)
  let body
  if (text.includes('原型设计')) {
    const note = `${marker}\nproto-worktree:${cwd}\n`
    writeFileSync(`${cwd}/prototype-note.txt`, note)
    body = `原型设计完成。需求标记 ${marker} 已写入 prototype-note.txt（工作区 ${cwd}）。`
  } else if (text.includes('任务设计与拆解')) {
    let note
    try {
      note = readFileSync(`${cwd}/prototype-note.txt`, 'utf8').trim()
    } catch {
      note = `<unreadable prototype-note.txt in ${cwd}>`
    }
    const plan = {
      stages: [
        {
          title: '实现设置页',
          agent: 'codex',
          spec: '读取 prototype-note.txt；把其内容写入 pipeline-proof.txt；如果任务说明里有「上游交接标记 PLAN-」开头的行，在报告里单独输出一行 saw-plan-uniq: yes；最后报告两个文件的内容。'
        }
      ]
    }
    body = [
      `任务设计完成。原型说明：${note}`,
      `上游交接标记 PLAN-${marker}`,
      '```orca-plan',
      JSON.stringify(plan),
      '```'
    ].join('\n')
  } else {
    let note
    try {
      note = readFileSync(`${cwd}/prototype-note.txt`, 'utf8').trim()
    } catch {
      note = `<unreadable prototype-note.txt in ${cwd}>`
    }
    writeFileSync(`${cwd}/pipeline-proof.txt`, `${note}\nimplemented:${cwd}\n`)
    const sawPlanUniq = text.includes('上游交接标记 PLAN-') ? 'yes' : 'no'
    body = [
      '实现设置页完成。',
      `saw-plan-uniq: ${sawPlanUniq}`,
      `prototype-note: ${note}`,
      `pipeline-proof: ${marker} / ${cwd}`
    ].join('\n')
  }
  emitAgentMessage(turnId, body, `msg-${turnId}`)
  completeTurn(turnId)
  reportWorkerDone(parsePreamble(text), body)
}

const server = createInterface({ input: process.stdin })
server.on('line', (line) => {
  if (!line.trim()) {
    return
  }
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = message
  if (id === undefined || id === null) {
    return
  }
  trace(`handle ${method}`)
  if (method === 'initialize') {
    respond(id, { userAgent: { name: 'fake-codex-stage', version: '0.164.0' } })
    return
  }
  if (method === 'thread/start' || method === 'thread/resume') {
    respond(id, { thread: { id: THREAD_ID, path: THREAD_PATH } })
    return
  }
  if (method === 'turn/start') {
    const turnId = `turn-${++nextTurn}`
    const text = Array.isArray(params?.input)
      ? params.input.map((entry) => entry?.text ?? '').join('\n')
      : ''
    respond(id, { turnId })
    notify('turn/started', { threadId: THREAD_ID, turn: { id: turnId } })
    notify('item/started', {
      threadId: THREAD_ID,
      turn: { id: turnId },
      item: { type: 'userMessage', id: `echo-${id}`, content: [{ type: 'text', text }] }
    })
    notify('item/completed', {
      threadId: THREAD_ID,
      turn: { id: turnId },
      item: { type: 'userMessage', id: `echo-${id}`, content: [{ type: 'text', text }] }
    })
    runStageTask(turnId, text)
    return
  }
  respond(id, {})
})
