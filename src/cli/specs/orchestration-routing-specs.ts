import { CLI_GLOBAL_FLAGS as GLOBAL_FLAGS } from '../../shared/cli/cli-argument-boundary'
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
      '--sub-actions is a JSON array of {text, constraints?, task?}; ids sa-{n}-{k} stay stable across restarts and re-decisions.',
      'A decision already recorded for the input is reused (same sub-action ids), never duplicated.'
    ]
  },
  {
    path: ['orchestration', 'routing-inputs-show'],
    summary: 'List recorded routing inputs with decisions, sub-actions and delivery attempts',
    usage: 'orca orchestration routing-inputs-show [--run <run_id>] [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'from'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'Recovery surface: after a restart, re-read every recorded input before resuming the routing flow.'
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
      "Without --expected-turn the Dispatch's active turn at send time is targeted.",
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
    path: ['orchestration', 'routing-supplement-continue'],
    summary:
      'Register (or reuse) the one continuation for a settled Dispatch\u2019s unconsumed sub-action',
    usage:
      'orca orchestration routing-supplement-continue --input <input_id> --sub-action <sa_id> --dispatch <dispatch_id> [--run <run_id>] [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'input', 'sub-action', 'dispatch', 'run', 'from'],
    identityFlagRoles: { from: 'caller' },
    notes: [
      'Send the follow-up via orchestration.send reusing the printed request id as --retry-request, then bind the new Dispatch with routing-continuation-bind.'
    ]
  },
  {
    path: ['orchestration', 'routing-continuation-bind'],
    summary: 'Bind a sub-action\u2019s continuation to its follow-up Dispatch (once)',
    usage:
      'orca orchestration routing-continuation-bind --sub-action <sa_id> --dispatch <dispatch_id> [--run <run_id>] [--from <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'sub-action', 'dispatch', 'run', 'from'],
    identityFlagRoles: { from: 'caller' }
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
