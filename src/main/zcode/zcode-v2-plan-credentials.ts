import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { homedir, platform, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { readNodeFileSyncWithinLimit } from '../../shared/file-content/node-bounded-file-reader'
import { ZCODE_PLAN_SITE_BASE_URLS } from '../../shared/agent-accounts/usage-credentials/zcode-plan-sites'
import { readSupportedZcodeV2Selection } from './zcode-v2-personal-overlay'

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
  | { status: 'ok'; apiKey: string; baseUrl: string; identity: string; configPath: string }

export function localZcodeCredentialHost(): ZcodeCredentialHost {
  let username = 'unknown'
  try {
    username = userInfo().username
  } catch {
    // Upstream uses the same fallback in sandboxed hosts.
  }
  return { home: homedir(), platform: platform(), username, env: process.env }
}

function userPath(value: string, home: string): string {
  if (value === '~') {
    return home
  }
  return value.startsWith('~/') ? join(home, value.slice(2)) : resolve(value)
}

// Read-only enc:v1 compatibility with ZCode 29628c9 credential-cipher.ts, plus the enc:v2
// layout current desktops write: enc:v2:<os|env>:<iv>.<tag>.<ciphertext> (base64url parts,
// sometimes prefixed with a 24-hex key fingerprint segment). v2/os keys live in the login
// keychain under the desktop's own service; reading it may ask the user for keychain access
// once — the same approval the zcode CLI itself needs.
const ZCODE_KEYCHAIN_SERVICE = 'ZCode Credential Encryption'
let osKeystoreKey: Buffer | null | undefined

function osKeystoreKeyForOs(keychainService: string): Buffer | null {
  if (osKeystoreKey !== undefined) {
    return osKeystoreKey
  }
  try {
    const password = execFileSync(
      'security',
      ['find-generic-password', '-s', keychainService, '-w'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000
      }
    ).trim()
    const key = Buffer.from(password, 'base64url')
    osKeystoreKey = key.length === 32 ? key : null
  } catch {
    osKeystoreKey = null
  }
  return osKeystoreKey
}

function v2KeyFor(source: string, host: ZcodeCredentialHost): Buffer | null {
  if (source === 'os') {
    if (platform() !== 'darwin') {
      // The keystore service is per-platform (keychain/libsecret/DPAPI); macOS is implemented.
      return null
    }
    return osKeystoreKeyForOs(ZCODE_KEYCHAIN_SERVICE)
  }
  const secret =
    host.env.ZCODE_CREDENTIAL_SECRET?.trim() ||
    `zcode-credential-fallback:${host.platform}:${host.home}:${host.username}`
  return createHash('sha256').update(secret).digest()
}

function gcmOpen(key: Buffer, payload: string): string {
  const parts = payload.split('.')
  const [nonce, tag, ciphertext] = parts
  if (parts.length !== 3 || !nonce || !tag || !ciphertext) {
    throw new Error('Invalid credential')
  }
  const iv = Buffer.from(nonce, 'base64url')
  const authTag = Buffer.from(tag, 'base64url')
  if (iv.length !== 12 || authTag.length !== 16) {
    throw new Error('Invalid credential')
  }
  const cipher = createDecipheriv('aes-256-gcm', key, iv)
  cipher.setAuthTag(authTag)
  return Buffer.concat([
    cipher.update(Buffer.from(ciphertext, 'base64url')),
    cipher.final()
  ]).toString('utf8')
}

/** Open one sealed zcode credential value (`enc:v1:`/`enc:v2:`), throwing when unavailable. */
export function openZcodeCredentialValue(value: string, host: ZcodeCredentialHost): string {
  if (value.startsWith('enc:v2:')) {
    const rest = value.slice('enc:v2:'.length)
    const colon = rest.indexOf(':')
    if (colon <= 0) {
      throw new Error('Invalid credential')
    }
    const source = rest.slice(0, colon)
    let payload = rest.slice(colon + 1)
    // Some writers prefix a 24-hex key fingerprint segment before the sealed payload.
    const fingerprint = /^([a-f0-9]{24}):(.+)$/.exec(payload)
    if (fingerprint) {
      payload = fingerprint[2]
    }
    const key = v2KeyFor(source, host)
    if (!key) {
      throw new Error(`zcode keystore key for ${source} is unavailable`)
    }
    return gcmOpen(key, payload)
  }
  if (!value.startsWith('enc:v1:')) {
    return value
  }
  const secret =
    host.env.ZCODE_CREDENTIAL_SECRET?.trim() ||
    `zcode-credential-fallback:${host.platform}:${host.home}:${host.username}`
  return gcmOpen(createHash('sha256').update(secret).digest(), value.slice('enc:v1:'.length))
}

/** Seal a plaintext into the current desktop layout (`enc:v2:os:` where the keystore serves). */
export function sealZcodeCredentialValue(plaintext: string, host: ZcodeCredentialHost): string {
  const source =
    platform() === 'darwin' && osKeystoreKeyForOs(ZCODE_KEYCHAIN_SERVICE) ? 'os' : 'env'
  const key = v2KeyFor(source, host)
  if (!key) {
    throw new Error(`zcode keystore key for ${source} is unavailable`)
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const sealed = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 24)
  return `enc:v2:${source}:${fingerprint}:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${sealed.toString('base64url')}`
}

function decrypt(value: string, host: ZcodeCredentialHost): string {
  return openZcodeCredentialValue(value, host)
}

export function readZcodeV2PlanCredential(
  host = localZcodeCredentialHost()
): ZcodeV2PlanCredential {
  const base = userPath(host.env.ZCODE_DATA_BASE_DIR ?? host.home, host.home)
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
    const store = credentialSchema.parse(
      JSON.parse(readV2File(join(base, '.zcode', 'v2', 'credentials.json')))
    )
    const rawIdentity = store[`account-provider:${selection.providerId}:identity`]
    if (!rawIdentity) {
      return { status: 'unavailable' }
    }
    const identity = decrypt(rawIdentity, host).trim()
    if (!identity) {
      return { status: 'unavailable' }
    }
    // Current desktops keep the plan auth as the OAuth access token (`oauth:<family>:access_token`)
    // instead of the per-account api-key entries older builds wrote.
    const siteFamily = [...sites].find(([provider]) => provider === selection.providerId)?.[1]
    const rawAccessToken =
      (siteFamily ? store[`oauth:${siteFamily}:access_token`] : undefined) ??
      store[
        `account-provider:coding-plan:${selection.providerId}:account:${encodeURIComponent(identity)}:api-key`
      ]
    if (!rawAccessToken) {
      return { status: 'unavailable' }
    }
    const apiKey = decrypt(rawAccessToken, host).trim()
    if (!apiKey || /[\r\n]/.test(apiKey)) {
      return { status: 'error' }
    }
    return {
      status: 'ok',
      apiKey,
      baseUrl: ZCODE_PLAN_SITE_BASE_URLS[site],
      identity: JSON.stringify([selection.providerId, identity]),
      configPath
    }
  } catch {
    return { status: 'error' }
  }
}
