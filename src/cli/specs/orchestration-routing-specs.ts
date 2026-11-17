import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli-argument-boundary'
import type { CommandSpec } from '../discovery/command-spec'

export const ORCHESTRATION_ROUTING_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['orchestration', 'routing-input-register'],
    summary: 'Save a persistent routing input and show its input id',
    usage:
      'orca orchestration routing-input-register --text <text> [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'text', 'run', 'from', 'retry-request'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'Inputs are saved before any decision; the printed inputId anchors every later sub-action and supplement.'
    ]
  },
  {
    path: ['orchestration', 'routing-decision-register'],
    summary: 'Register an input decision and its stable sub-actions (sa-{n}-{k})',
    usage:
      'orca orchestration routing-decision-register --input <input_id> --sub-actions <json_array> [--run <run_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'input', 'sub-actions', 'run', 'from', 'retry-request'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      '--sub-actions is a JSON array of {text, constraints?, task?}; ids sa-{n}-{k} stay stable across restarts and re-decisions.'
    ]
  },
  {
    path: ['orchestration', 'routing-supplement-send'],
    summary: 'Deliver a supplement to exactly one named active turn of a Dispatch',
    usage:
      'orca orchestration routing-supplement-send --input <input_id> --sub-action <sa_id> --dispatch <dispatch_id> --text <text> [--expected-turn <turn_id>] [--from <handle>] [--retry-request <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'input',
      'sub-action',
      'dispatch',
      'text',
      'expected-turn',
      'from',
      'retry-request'
    ],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'Without --expected-turn the Dispatch\'s active turn at send time is targeted.',
      'A refusal (turn ended, no active turn, not a structured session) is a recorded fact bound to the expected turn; the supplement is never re-targeted and no new turn is started.'
    ]
  },
  {
    path: ['orchestration', 'routing-supplement-show'],
    summary: 'Show supplements and their delivery attempts with receipts',
    usage:
      'orca orchestration routing-supplement-show (--supplement <id> | --sub-action <sa_id>) [--run <run_id>] [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'supplement', 'sub-action', 'run', 'from'],
    identityFlagRoles: { from: 'caller' },
    notes: ['Attempts carry outcome delivered/refused, refusal kind, expected turn and request id.']
  },
  {
    path: ['orchestration', 'routing-target-show'],
    summary: 'Show the structured session and active turn a Dispatch currently resolves to',
    usage:
      'orca orchestration routing-target-show --dispatch <dispatch_id> [--run <run_id>] [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'dispatch', 'run', 'from'],
    identityFlagRoles: { from: 'caller' }
  }
]
