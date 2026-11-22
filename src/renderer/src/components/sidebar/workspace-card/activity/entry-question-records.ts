import { z } from 'zod'

export const pendingAskSchema = z.object({
  messageId: z.string(),
  dispatchId: z.string().optional(),
  body: z.string(),
  createdAt: z.string().optional()
})

export const answeredAskSchema = z.object({
  messageId: z.string(),
  dispatchId: z.string().optional(),
  question: z.string(),
  answer: z.string(),
  createdAt: z.string().optional(),
  answeredAt: z.string()
})

export type RoutingEntryPendingAsk = z.infer<typeof pendingAskSchema>
export type RoutingEntryAnsweredAsk = z.infer<typeof answeredAskSchema>
