const INVESTIGATION =
  /^(?:请\s*)?(?:先\s*)?(?:(?:让|用)\s*\w+\s*)?(?:只读|调查|排查|查(?:看|清|明)?|分析|核查|\b(?:investigate|diagnose|inspect|analyze)\b)/iu
const WRITE_CONFIRMATION =
  /(?:等|待|经)(?:我|用户|人工)?(?:明确)?(?:确认|同意|批准|授权)[^。！？.]{0,24}(?:改|写|修|实施)|(?:改|写|修|实施)[^。！？.]{0,24}(?:前|之前)[^。！？.]{0,12}(?:确认|同意|批准|授权)|\b(?:wait for|after|until|before)\b[^.!?]{0,55}\b(?:confirm(?:ation)?|approv(?:al|e)|permission)\b/iu
const INVESTIGATE_THEN_WRITE =
  /(?:再|然后|随后|之后)\s*(?:按[^。！？]{0,10})?(?:改|写|修|实施)|\b(?:then|and)\s+(?:fix|change|edit|write|implement)\b/iu
const READ_ONLY = /(?:只读|read[- ]only)/iu

export function requiresEntryWriteApproval(text: string): boolean {
  return WRITE_CONFIRMATION.test(text) || READ_ONLY.test(text)
}

export function entryInvestigationNeedsReadOnly(action: string): boolean {
  return INVESTIGATION.test(action) && !INVESTIGATE_THEN_WRITE.test(action)
}
