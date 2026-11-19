import { homedir, platform, userInfo } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { readNodeFileSyncWithinLimit } from '../../shared/file-content/node-bounded-file-reader'
import { ZCODE_PLAN_SITE_BASE_URLS } from '../../shared/agent-accounts/usage-credentials/zcode-plan-sites'
import { openZcodeCredentialValue, userPath } from './zcode-credential-cipher'
import { readSupportedZcodeV2Selection } from './zcode-v2-personal-overlay'
import { readZcodeV2ProjectPlanKey } from './zcode-v2-project-plan-key'

const MAX_V2_FILE_BYTES = 4 * 1024 * 1024
function readV2File(path: string): string {
  return readNodeFileSyncWithinLimit(path, MAX_V2_FILE_BYTES, {
    regularFileOnly: true
  }).buffer.toString('utf8')
}

const credentialSchema = z.record(z.string(), z.string())
const sites = new Map([
  ['account:zai-individual-coding-plan', 'zai'],
  ['account:bigmodel-individual-coding-plan', 'bigmodel']
] as const)

export type ZcodeCredentialHost = {
  home: string
  platform: string
  username: string
  env: NodeJS.ProcessEnv
}

export type ZcodeV2PlanCredential =
  | { status: 'absent' | 'unavailable' | 'error' }
  | {
      status: 'ok'
      apiKey: string
      baseUrl: string
      identity: string
      configPath: string
      /** The v2 selection's model — the decision provider routes on the user's own model. */
      modelId: string
    }

export function localZcodeCredentialHost(): ZcodeCredentialHost {
  let username = 'unknown'
  try {
    username = userInfo().username
  } catch {
    // Upstream uses the same fallback in sandboxed hosts.
  }
  return { home: homedir(), platform: platform(), username, env: process.env }
}

export async function readZcodeV2PlanCredential(
  host = localZcodeCredentialHost(),
  options: { preferInferenceKey?: boolean } = {}
): Promise<ZcodeV2PlanCredential> {
  const base = userPath(host.env.ZCODE_DATA_BASE_DIR ?? host.home, host.home)
  const credentialsPath = join(base, '.zcode', 'v2', 'credentials.json')
  const configPath =
    (host.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim()
      ? userPath(host.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE.trim(), host.home)
      : '') || join(base, '.zcode', 'v2', 'provider_config.json')
  let rawConfig: string
  try {
    rawConfig = readV2File(configPath)
  } catch (error) {
    return {
      status:
        error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'absent' : 'error'
    }
  }
  try {
    const selection = readSupportedZcodeV2Selection(JSON.parse(rawConfig))
    if (!selection) {
      return { status: 'unavailable' }
    }
    const site = [...sites].find(([provider]) => provider === selection.providerId)?.[1]
    if (!site) {
      return { status: 'unavailable' }
    }
    const store = credentialSchema.parse(JSON.parse(readV2File(credentialsPath)))
    const rawIdentity = store[`account-provider:${selection.providerId}:identity`]
    if (!rawIdentity) {
      return { status: 'unavailable' }
    }
    const identity = (await openZcodeCredentialValue(rawIdentity, host, credentialsPath)).trim()
    if (!identity) {
      return { status: 'unavailable' }
    }
    const sealedKey =
      store[
        `account-provider:coding-plan:${selection.providerId}:account:${encodeURIComponent(identity)}:api-key`
      ]
    const oauth = store[`oauth:${site}:access_token`]
    const inferenceKey = options.preferInferenceKey
      ? sealedKey
        ? await openZcodeCredentialValue(sealedKey, host, credentialsPath)
        : await readZcodeV2ProjectPlanKey({
            store,
            host,
            path: credentialsPath,
            site,
            providerId: selection.providerId,
            identity
          })
      : undefined
    const fallback = oauth ?? sealedKey
    const apiKey = (
      inferenceKey ??
      (fallback ? await openZcodeCredentialValue(fallback, host, credentialsPath) : '')
    ).trim()
    if (!fallback && !inferenceKey) {
      return { status: 'unavailable' }
    }
    if (!apiKey || /[\r\n]/.test(apiKey)) {
      return { status: 'error' }
    }
    return {
      status: 'ok',
      apiKey,
      baseUrl: ZCODE_PLAN_SITE_BASE_URLS[site],
      identity: JSON.stringify([selection.providerId, identity]),
      configPath,
      modelId: selection.modelId
    }
  } catch {
    return { status: 'error' }
  }
}
