import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../../shared/file-content/node-bounded-file-reader'
import type { ZcodeCredentialHost } from './zcode-v2-plan-credentials'

// Orca's port of the zcode CLI's credential-cipher: the enc:v1 legacy layout plus the enc:v2
// layout current desktops write — enc:v2:<os|env>:<iv>.<tag>.<ciphertext> (base64url parts,
// sometimes prefixed with a 24-hex key fingerprint segment). v2 keys live in the platform
// keystore under the desktop's own service (macOS login keychain, Windows Credential Manager,
// Linux Secret Service); reading it may ask the user for keystore access once — the same
// approval the zcode CLI itself needs. The CLI's own ladder also serves env-sourced keys from
// ZCODE_CREDENTIAL_SECRET, ZCODE_CREDENTIAL_SECRET_FILE, or a sibling credential-secret file.

const MAX_V2_FILE_BYTES = 4 * 1024 * 1024
const ZCODE_KEYSTORE_SERVICE = 'ZCode Credential Encryption'
const osKeystoreKeyCache = new Map<string, Buffer | null>()

function readV2File(path: string): string {
  return readNodeFileSyncWithinLimit(path, MAX_V2_FILE_BYTES, {
    regularFileOnly: true
  }).buffer.toString('utf8')
}

export function userPath(value: string, home: string): string {
  if (value === '~') {
    return home
  }
  return value.startsWith('~/') ? join(home, value.slice(2)) : resolve(value)
}

/** The sealed v2 credentials store path (`~/.zcode/v2/credentials.json` by default). */
export function zcodeV2CredentialsStorePath(host: ZcodeCredentialHost): string {
  const base = userPath(host.env.ZCODE_DATA_BASE_DIR ?? host.home, host.home)
  return join(base, '.zcode', 'v2', 'credentials.json')
}

function decodeKeystorePassword(password: string): Buffer | null {
  try {
    const key = Buffer.from(password.trim(), 'base64url')
    return key.length === 32 ? key : null
  } catch {
    return null
  }
}

function macKeystorePassword(service: string): string | null {
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000
    }).trim()
  } catch {
    return null
  }
}

// CredRead of a generic credential through built-in PowerShell (no extra modules). napi-rs
// keyring target shapes vary by version, so both `service` and `service.account` are probed;
// the password may be stored UTF-8 or UTF-16 — disambiguated by NUL scan.
const WINDOWS_CREDREAD_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class ZcCredMan {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, int type, int reserved, out IntPtr credPtr);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string ReadBlobBase64(string target) {
    IntPtr credPtr;
    if (!CredRead(target, 1, 0, out credPtr)) { return null; }
    try {
      CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
      byte[] blob = new byte[cred.CredentialBlobSize];
      Marshal.Copy(cred.CredentialBlob, blob, 0, blob.Length);
      return Convert.ToBase64String(blob);
    } finally { CredFree(credPtr); }
  }
}
'@
$blob = [ZcCredMan]::ReadBlobBase64($args[0])
if (-not $blob) {
  $blob = [ZcCredMan]::ReadBlobBase64($args[1])
}
if (-not $blob) { exit 1 }
$bytes = [Convert]::FromBase64String($blob)
$text = [Text.Encoding]::UTF8.GetString($bytes)
if ($text.IndexOf([char]0) -ge 0) { $text = [Text.Encoding]::Unicode.GetString($bytes) }
Write-Output $text
`

function windowsKeystorePassword(service: string, account: string): string | null {
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_CREDREAD_SCRIPT,
        service,
        `${service}.${account}`
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }
    )
    for (const line of output.split(/\r?\n/)) {
      const password = line.trim()
      if (decodeKeystorePassword(password)) {
        return password
      }
    }
    return null
  } catch {
    return null
  }
}

/** The keystore key that seals/unseals `enc:v2:os:` values for this credentials file. */
function osKeystoreKeyFor(platformId: string, credentialsPath: string): Buffer | null {
  const account = createHash('sha256').update(resolve(credentialsPath)).digest('hex')
  const cacheKey = `${platformId}:${account}`
  const cached = osKeystoreKeyCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }
  let key: Buffer | null = null
  try {
    if (platformId === 'darwin') {
      key = decodeKeystorePassword(macKeystorePassword(ZCODE_KEYSTORE_SERVICE) ?? '')
    } else if (platformId === 'win32') {
      key = decodeKeystorePassword(windowsKeystorePassword(ZCODE_KEYSTORE_SERVICE, account) ?? '')
    }
    // Linux (Secret Service) intentionally not implemented yet; the store stays unavailable.
  } catch {
    key = null
  }
  osKeystoreKeyCache.set(cacheKey, key)
  return key
}

// The CLI's managed-secret ladder: ZCODE_CREDENTIAL_SECRET, ZCODE_CREDENTIAL_SECRET_FILE, or the
// sibling credential-secret file (owner-only on POSIX); content 32–4096 bytes.
function managedSecretFor(host: ZcodeCredentialHost, credentialsPath: string): string | null {
  const secret = host.env.ZCODE_CREDENTIAL_SECRET?.trim()
  const secretFile = host.env.ZCODE_CREDENTIAL_SECRET_FILE?.trim()
  if (secret && secretFile) {
    return null
  }
  if (secret) {
    return secret
  }
  const path = secretFile || join(dirname(credentialsPath), 'credential-secret')
  let content: string
  try {
    content = readV2File(path)
  } catch {
    return null
  }
  if (Buffer.byteLength(content, 'utf8') < 32 || Buffer.byteLength(content, 'utf8') > 4096) {
    return null
  }
  if (!secretFile && platform() !== 'win32') {
    try {
      if ((statSync(path).mode & 0o77) !== 0) {
        return null
      }
    } catch {
      return null
    }
  }
  return content
}

function v2KeyFor(
  source: string,
  host: ZcodeCredentialHost,
  credentialsPath: string
): Buffer | null {
  if (source === 'os') {
    return osKeystoreKeyFor(platform(), credentialsPath)
  }
  const managed = managedSecretFor(host, credentialsPath)
  if (!managed) {
    return null
  }
  return createHash('sha256').update(managed).digest()
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
export function openZcodeCredentialValue(
  value: string,
  host: ZcodeCredentialHost,
  credentialsPath: string = zcodeV2CredentialsStorePath(host)
): string {
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
    const key = v2KeyFor(source, host, credentialsPath)
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
export function sealZcodeCredentialValue(
  plaintext: string,
  host: ZcodeCredentialHost,
  credentialsPath: string = zcodeV2CredentialsStorePath(host)
): string {
  const source =
    platform() === 'darwin' || platform() === 'win32'
      ? osKeystoreKeyFor(platform(), credentialsPath)
        ? 'os'
        : 'env'
      : 'env'
  const key = v2KeyFor(source, host, credentialsPath)
  if (!key) {
    throw new Error(`zcode keystore key for ${source} is unavailable`)
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const sealed = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 24)
  return `enc:v2:${source}:${fingerprint}:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${sealed.toString('base64url')}`
}
