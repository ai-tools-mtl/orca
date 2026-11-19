import { afterEach, expect, it, vi } from 'vitest'
import { readZcodePlanApiKey } from '../../zcode-plan-api-key-store'
import { readZcodeV2PlanCredential } from '../../zcode-v2-plan-credentials'
import { resolveZcodeChatCredentials } from './zcode-chat-credentials'

vi.mock('../../zcode-plan-api-key-store', () => ({ readZcodePlanApiKey: vi.fn() }))
vi.mock('../../zcode-v2-plan-credentials', () => ({
  localZcodeCredentialHost: vi.fn(),
  readZcodeV2PlanCredential: vi.fn()
}))

afterEach(() => vi.resetAllMocks())

it('uses the active BigModel login when the default Z.AI site has no Orca key', async () => {
  vi.mocked(readZcodePlanApiKey).mockReturnValue(null)
  vi.mocked(readZcodeV2PlanCredential).mockResolvedValue({
    status: 'ok',
    apiKey: 'synthetic-v2-token',
    baseUrl: 'https://open.bigmodel.cn',
    identity: 'test-account',
    configPath: '/test/provider_config.json',
    modelId: 'GLM-5.3'
  })

  expect(await resolveZcodeChatCredentials({ site: 'zai' })).toEqual({
    site: 'bigmodel',
    providerId: 'account:bigmodel-individual-coding-plan',
    apiKey: 'synthetic-v2-token'
  })
})
