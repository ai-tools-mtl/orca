import { expect, it } from 'vitest'
import { readZcodeV2ProjectPlanKey } from './zcode-v2-project-plan-key'

it('reuses an older key slot only when the active personal plan references its key ID', async () => {
  const providerId = 'account:bigmodel-individual-coding-plan'
  const keySlot = (identity: string) =>
    `account-provider:coding-plan:${providerId}:account:${identity}:api-key`
  const locationSlot = (identity: string) =>
    `project-key-location:v1:${encodeURIComponent(
      JSON.stringify(['https://example.test', 'bigmodel', identity, null, 1, 'non-team'])
    )}`
  const store = {
    [keySlot('another-legacy-id')]: 'other-key-id.synthetic-secret',
    [keySlot('legacy-id')]: 'current-key-id.synthetic-secret',
    [locationSlot('another-account')]: '{"apiKeyId":"other-key-id"}',
    [locationSlot('current-account')]: '{"apiKeyId":"current-key-id"}'
  }
  const selection = {
    store,
    host: { home: '/test', platform: 'linux', username: 'test', env: {} },
    path: '/test/credentials.json',
    providerId,
    site: 'bigmodel'
  }

  expect(await readZcodeV2ProjectPlanKey({ ...selection, identity: 'current-account' })).toBe(
    'current-key-id.synthetic-secret'
  )
  expect(
    await readZcodeV2ProjectPlanKey({ ...selection, identity: 'unknown-account' })
  ).toBeUndefined()
})
