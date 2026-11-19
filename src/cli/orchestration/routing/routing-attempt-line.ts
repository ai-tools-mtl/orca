/** One supplement attempt as the --full receipt line (plan §6: attempts are receipts). */
export function attemptRowLine(attempt: {
  attempt_id: string
  request_id: string
  expected_turn_id: string | null
  outcome: string
  refusal_kind: string | null
  turn_id: string | null
}): string {
  const parts = [
    `attempt ${attempt.attempt_id}`,
    `outcome=${attempt.outcome}`,
    `request ${attempt.request_id}`
  ]
  if (attempt.expected_turn_id) {
    parts.push(`expectedTurn ${attempt.expected_turn_id}`)
  }
  if (attempt.turn_id) {
    parts.push(`turn ${attempt.turn_id}`)
  }
  if (attempt.refusal_kind) {
    parts.push(`refused:${attempt.refusal_kind}`)
  }
  return parts.join(' ')
}
