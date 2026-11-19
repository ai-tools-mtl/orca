import { z } from 'zod'
import { openZcodeCredentialValue } from './zcode-credential-cipher'
import type { ZcodeCredentialHost } from './zcode-v2-plan-credentials'

const LOCATION_PREFIX = 'project-key-location:v1:'
const locationScope = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.null(),
  z.literal(1),
  z.literal('non-team')
])
const storedLocation = z.object({ apiKeyId: z.string().min(1) })

async function activeProjectKeyIds(args: {
  store: Record<string, string>
  host: ZcodeCredentialHost
  path: string
  site: string
  identity: string
}): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const [name, value] of Object.entries(args.store)) {
    if (!name.startsWith(LOCATION_PREFIX)) {
      continue
    }
    try {
      const scope = locationScope.safeParse(
        JSON.parse(decodeURIComponent(name.slice(LOCATION_PREFIX.length)))
      )
      if (!scope.success || scope.data[1] !== args.site || scope.data[2] !== args.identity) {
        continue
      }
      const location = storedLocation.parse(
        JSON.parse(await openZcodeCredentialValue(value, args.host, args.path))
      )
      ids.add(location.apiKeyId)
    } catch {
      // A stale location is not evidence that a key belongs to this account.
    }
  }
  return ids
}

export async function readZcodeV2ProjectPlanKey(args: {
  store: Record<string, string>
  host: ZcodeCredentialHost
  path: string
  site: string
  providerId: string
  identity: string
}): Promise<string | undefined> {
  const ids = await activeProjectKeyIds(args)
  if (ids.size === 0) {
    return undefined
  }
  const prefix = `account-provider:coding-plan:${args.providerId}:account:`
  for (const [name, value] of Object.entries(args.store)) {
    if (!name.startsWith(prefix) || !name.endsWith(':api-key')) {
      continue
    }
    try {
      const key = (await openZcodeCredentialValue(value, args.host, args.path)).trim()
      const [id, secret, extra] = key.split('.')
      if (ids.has(id) && secret && extra === undefined && !/[\r\n]/.test(key)) {
        return key
      }
    } catch {
      // The cache can include retired account aliases.
    }
  }
  return undefined
}
