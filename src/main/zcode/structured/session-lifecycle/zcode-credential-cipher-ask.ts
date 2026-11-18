import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ZcodeAppServerConnection } from '../../app-server/zcode-app-server-connection-types'
import type { ZcodeCredentialHost } from '../../zcode-v2-plan-credentials'
import { localZcodeCredentialHost } from '../../zcode-v2-plan-credentials'
import {
  openZcodeCredentialValue,
  sealZcodeCredentialValue,
  zcodeV2CredentialsStorePath
} from '../../zcode-credential-cipher'

// The CLI delegates its sealed-store crypto to the host over this ask; a headless Orca is the
// host, and without the bridge the CLI cannot read its own OAuth tokens and every model call
// stalls silently.

const bridgeSchema = z.object({
  requestId: z.string().uuid(),
  operation: z.enum(['encrypt', 'decrypt']),
  value: z.string()
})

type CipherBridgeReply =
  | { requestId: string; result: { ok: true; value: string } }
  | { requestId: string; result: { ok: false; error: { code: string; message: string } } }

function requestIdOf(params: unknown): string {
  if (typeof params === 'object' && params !== null && 'requestId' in params) {
    const value: unknown = params.requestId
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }
  return randomUUID()
}

/** Answers `interaction/requestCredentialCipher` with Orca's own keystore-backed crypto. */
export class ZcodeCredentialCipherAsks {
  answer(input: {
    connection: Pick<ZcodeAppServerConnection, 'respond'>
    params: unknown
    id: number | string
  }): void {
    input.connection.respond(input.id, this.reply(input.params))
  }

  private reply(params: unknown): CipherBridgeReply {
    const requestId = requestIdOf(params)
    const fail = (message: string): CipherBridgeReply => ({
      requestId,
      result: { ok: false, error: { code: 'credential_cipher_failed', message } }
    })
    const parsed = bridgeSchema.safeParse(params)
    if (!parsed.success) {
      return fail('malformed cipher request')
    }
    const host: ZcodeCredentialHost = localZcodeCredentialHost()
    const credentialsPath = zcodeV2CredentialsStorePath(host)
    try {
      if (parsed.data.operation === 'decrypt') {
        return {
          requestId,
          result: {
            ok: true,
            value: openZcodeCredentialValue(parsed.data.value, host, credentialsPath)
          }
        }
      }
      return {
        requestId,
        result: {
          ok: true,
          value: sealZcodeCredentialValue(parsed.data.value, host, credentialsPath)
        }
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'cipher failed')
    }
  }
}
