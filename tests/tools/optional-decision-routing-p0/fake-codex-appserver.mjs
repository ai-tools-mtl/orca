#!/usr/bin/env node
/** Deterministic codex app-server protocol stand-in for the P0 targeted-delivery flow.
 *  Speaks the real NDJSON wire (initialize → thread/start → turn/start|turn/steer → notifications)
 *  so the real Codex structured adapter, journal evidence and routing ledger run unmodified;
 *  only the model layer is scripted.
 *
 *  Scenario handling (driven by the task text Orca sends):
 *  - gate preamble (`gate-wait.sh <gateFile>`): opens a turn whose command item stays inProgress
 *    until the gate file exists; the turn only completes after a steer, whose first new item is
 *    a read of new.txt (commandActions) followed by an agentMessage with new.txt's real content.
 *  - any other text: reads the named file (old.txt default), reports its real content, completes
 *    the turn, then reports worker_done through the `orca` CLI on PATH (the E2E shim).
 *  - turn/steer with no open turn: JSON-RPC error (CodexAppServerRequestError path).
 *  - `--version`: prints a version above the structured-launch minimum. */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

// Unconditional startup marker: proves this process ran, independent of trace env.
try {
  appendFileSync('/tmp/p0-fake-started.log', `${Date.now()} argv=${process.argv.join(' ')}\n`)
} catch {}
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
/** The open turn: { id, gateFile, steered } | null. */
let openTurn = null
let workerDoneSent = false

trace(`started argv=${process.argv.join(' ')} cwd=${process.cwd()} ppid=${process.ppid}`)
const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)
const respond = (id, result) => write({ id, result })
const respondError = (id, code, message) => write({ id, error: { code, message } })
const notify = (method, params) => write({ method, params })

function parsePreamble(text) {
  const coordinator = text.match(/coordinator's terminal handle is:\s*(\S+)/)?.[1] ?? null
  const taskId = text.match(/Your task ID is:\s*(\S+)/)?.[1] ?? null
  const dispatchId = text.match(/--dispatch-id\s+(\S+)/)?.[1] ?? null
  const workerHandle = text.match(/--from\s+(\S+)\s+--type worker_done/)?.[1] ?? null
  return { coordinator, taskId, dispatchId, workerHandle }
}

function reportWorkerDone(identity, summary) {
  if (workerDoneSent || !identity.workerHandle || !identity.taskId || !identity.dispatchId) {
    return
  }
  workerDoneSent = true
  const args = [
    'orchestration', 'send',
    '--from', identity.workerHandle,
    '--type', 'worker_done',
    '--subject', 'fake worker finished',
    '--body', summary,
    '--task-id', identity.taskId,
    '--dispatch-id', identity.dispatchId,
    '--outcome', 'succeeded',
    '--json'
  ]
  const child = spawn('orca', args, { stdio: 'ignore', env: process.env })
  child.on('error', () => {})
}

function emitItem(turnId, item) {
  notify('item/started', { threadId: THREAD_ID, turn: { id: turnId }, item })
}

function completeItem(turnId, item) {
  notify('item/completed', { threadId: THREAD_ID, turn: { id: turnId }, item })
}

function readMarker(cwd, file) {
  try {
    return readFileSync(`${cwd}/${file}`, 'utf8').trim()
  } catch {
    return `<unreadable ${file}>`
  }
}

function emitRead(turnId, cwd, file, id) {
  const item = {
    type: 'commandExecution',
    id,
    command: `cat ${file}`,
    cwd,
    status: 'inProgress',
    commandActions: [{ type: 'read', path: `${cwd}/${file}` }]
  }
  emitItem(turnId, item)
  const completed = { ...item, status: 'completed', exitCode: 0, output: readMarker(cwd, file) }
  completeItem(turnId, completed)
  return completed
}

function emitAgentMessage(turnId, text, id) {
  const item = { type: 'agentMessage', id, text }
  emitItem(turnId, item)
  completeItem(turnId, item)
}

function completeTurn(turnId, status = 'completed') {
  notify('turn/completed', { threadId: THREAD_ID, turn: { id: turnId, status } })
  if (openTurn?.id === turnId) {
    openTurn = null
  }
}

function runPlainTask(turnId, text) {
  const cwd = process.cwd()
  const file = text.includes('new.txt') ? 'new.txt' : 'old.txt'
  const marker = readMarker(cwd, file)
  emitRead(turnId, cwd, file, `cmd-read-${turnId}`)
  emitAgentMessage(turnId, `The marker inside ${file} is: ${marker}`, `msg-${turnId}`)
  completeTurn(turnId)
  const identity = parsePreamble(text)
  reportWorkerDone(identity, `Read ${file} and reported its marker. Found ${marker}. Nothing left.`)
}

function startGateTurn(turnId, text, id) {
  const gateFile = text.match(/gate-wait\.sh\s+"?([^"\s]+)"?/)?.[1] ?? null
  const cwd = process.cwd()
  openTurn = { id: turnId, gateFile, steered: false }
  notify('turn/started', { threadId: THREAD_ID, turn: { id: turnId } })
  emitItem(turnId, {
    type: 'commandExecution',
    id,
    command: gateFile ? `bash gate-wait.sh ${gateFile}` : 'bash gate-wait.sh',
    cwd,
    status: 'inProgress'
  })
  if (!gateFile) {
    return
  }
  const watch = setInterval(() => {
    if (!existsSync(gateFile)) {
      return
    }
    clearInterval(watch)
    // The gate command completes on release; the turn itself stays open for the steer.
    completeItem(turnId, {
      type: 'commandExecution',
      id,
      command: `bash gate-wait.sh ${gateFile}`,
      cwd,
      status: 'completed',
      exitCode: 0,
      output: 'released'
    })
  }, 200)
}

function steerOpenTurn(params, id) {
  const turn = openTurn
  const expected = typeof params?.expectedTurnId === 'string' ? params.expectedTurnId : ''
  if (!turn || turn.id !== expected) {
    respondError(id, -32000, `expected active turn id \`${expected}\` but found \`${turn?.id ?? 'none'}\``)
    return
  }
  respond(id, { turnId: turn.id })
  const cwd = process.cwd()
  const steerText = Array.isArray(params?.input)
    ? params.input.map((entry) => entry?.text ?? '').join('\n')
    : ''
  emitItem(turn.id, {
    type: 'userMessage',
    id: `echo-${id}`,
    clientId: typeof params?.clientUserMessageId === 'string' ? params.clientUserMessageId : null,
    content: [{ type: 'text', text: steerText }]
  })
  if (turn.steered) {
    return
  }
  turn.steered = true
  emitRead(turn.id, cwd, 'new.txt', `cmd-read-steer-${turn.id}`)
  emitAgentMessage(turn.id, `The marker inside new.txt is: ${readMarker(cwd, 'new.txt')}`, `msg-steer-${turn.id}`)
  const identity = parsePreamble(turn.preambleText ?? '')
  completeTurn(turn.id)
  reportWorkerDone(identity, `Steered to new.txt; read and reported its marker. Nothing left.`)
}

const server = createInterface({ input: process.stdin })
server.on('line', (line) => {
  if (!line.trim()) {
    return
  }
  trace(`recv ${line.slice(0, 200)}`)
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
  switch (method) {
    case 'initialize':
      respond(id, { userAgent: { name: 'fake-codex', version: '0.164.0' } })
      return
    case 'thread/start':
    case 'thread/resume':
      respond(id, { thread: { id: THREAD_ID, path: THREAD_PATH } })
      return
    case 'turn/start': {
      const turnId = `turn-${++nextTurn}`
      const text = Array.isArray(params?.input)
        ? params.input.map((entry) => entry?.text ?? '').join('\n')
        : ''
      respond(id, { turnId })
      const echo = () =>
        emitItem(turnId, {
          type: 'userMessage',
          id: `echo-${id}`,
          clientId: typeof params?.clientUserMessageId === 'string' ? params.clientUserMessageId : null,
          content: [{ type: 'text', text }]
        })
      if (text.includes('gate-wait.sh')) {
        notify('turn/started', { threadId: THREAD_ID, turn: { id: turnId } })
        echo()
        startGateTurn(turnId, text, `cmd-gate-${turnId}`)
        if (openTurn) {
          openTurn.preambleText = text
        }
      } else {
        notify('turn/started', { threadId: THREAD_ID, turn: { id: turnId } })
        echo()
        runPlainTask(turnId, text)
      }
      return
    }
    case 'turn/steer':
      steerOpenTurn(params, id)
      return
    case 'turn/interrupt':
      respond(id, {})
      if (openTurn) {
        completeTurn(openTurn.id, 'interrupted')
      }
      return
    default:
      respond(id, {})
  }
})
