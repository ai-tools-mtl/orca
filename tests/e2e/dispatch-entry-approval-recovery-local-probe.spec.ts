import { copyFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'

const request = '修登录，另外查启动慢，两项都不要改配置，启动问题等我确认才修改'
test.setTimeout(210_000)

type SubActionRow = {
  subAction: { text: string; sub_action_id: string; task_id: string }
  execution?: { dispatchId: string; status?: string }
}
type InputRow = { input: { input_id: string; decision_json: string }; subActions: SubActionRow[] }
type ApprovalRow = {
  approvalId: string
  dispatchId?: string
  detail?: string
  title?: string
  interrupted: boolean
}
type EntryFacts = [{ inputs: InputRow[] }, { approvals?: ApprovalRow[] | null }]

async function paths(root: string): Promise<string[]> {
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => [])
  return (
    await Promise.all(
      dirs.map((d) => (d.isDirectory() ? paths(join(root, d.name)) : [join(root, d.name)]))
    )
  ).flat()
}

async function setupView(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.waitForFunction(
    () => window.__store?.getState().workspaceSessionReady === true,
    null,
    { timeout: 35_000 }
  )
}

async function openEntry(page: Page) {
  const pane = page.locator('[data-dispatch-entry-chat]')
  if (!(await pane.isVisible())) {
    await page
      .getByRole('button', { name: /^(Project dispatch|项目调度)$/ })
      .click({ timeout: 15_000 })
  }
  return pane
}

async function readFacts(page: Page, group: string) {
  return page.evaluate(async (group) => {
    const conditions = await Promise.all(
      ['orchestration.entryShow', 'orchestration.entryApprovals'].map((method) =>
        window.api.runtime.call({ method, params: { group } })
      )
    )
    return conditions.map((out) => (out.ok ? out.result : { error: out.error }))
  }, group) as Promise<EntryFacts>
}

async function readProbe(home: string, marker: string) {
  for (const file of (await paths(join(home, 'sessions'))).filter((f) => f.endsWith('.jsonl'))) {
    const rows = (await readFile(file, 'utf8').catch(() => '')).split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
    const calls = rows.filter(
      (row) =>
        row.type === 'response_item' &&
        ['custom_tool_call', 'function_call'].includes(row.payload?.type)
    )
    const write = calls.find((row) => JSON.stringify(row.payload).includes(marker))
    if (!write) {
      continue
    }
    const denied = rows.some(
      (row) =>
        row.type === 'response_item' &&
        row.payload?.call_id === write.payload.call_id &&
        /operation not permitted|permission denied|read.only file system/i.test(
          JSON.stringify(row.payload)
        )
    )
    const postDeny = calls.find((row) => JSON.stringify(row.payload).includes('POST_DENY_PROBE'))
    return {
      cwd: rows.find((row) => row.type === 'turn_context')?.payload?.cwd,
      turn: rows.find((row) => row.type === 'turn_context')?.payload?.turn_id,
      denied,
      permission: rows.find((row) => row.type === 'turn_context')?.payload?.sandbox_policy?.type,
      postDenyDenied:
        !!postDeny &&
        rows.some(
          (row) =>
            row.type === 'response_item' &&
            row.payload?.call_id === postDeny.payload.call_id &&
            /operation not permitted|permission denied|read.only file system/i.test(
              JSON.stringify(row.payload)
            )
        )
    }
  }
  return null
}

const control = process.env.ORCA_DISPATCH_TEST_FRESH_CONTROL === '1'
for (const branch of ['deny', 'allow'] as const) {
  test(`live ${branch} of a pending startup write ${control ? 'without restarting' : 'after restarting'}`, async (_, info) => {
    const restart = createRestartSession(info, { ORCA_BACKGROUND_LAUNCH: '1' })
    const out = process.env.ORCA_DISPATCH_PROOF_DIR!
    const root = await mkdtemp(join(tmpdir(), 'orca-live-approval-restart-'))
    const repo = join(root, 'DispatchQA')
    const workspaceDir = join(root, 'worktrees')
    const marker = 'PRE_APPROVAL_PROBE'
    const allowedValue = 'STARTUP_WRITE_APPROVED'
    const config = '{"fixtureConfig":"UNCHANGED"}\n'
    await mkdir(repo)
    await mkdir(workspaceDir)
    await writeFile(join(repo, 'fixture-config.json'), config)
    await writeFile(join(repo, 'startup-probe.txt'), 'STARTUP_ORIGINAL\n')
    await writeFile(join(repo, 'login.js'), 'module.exports = name => name === "current";\n')
    await writeFile(
      join(repo, 'AGENTS.md'),
      [
        '# Isolated live approval fixture',
        'Do not modify any configuration file. Only these dummy checked-in test files are in scope.',
        'For the login-fix task, edit only login.js to accept both "legacy" and "current". Verify and report completion.',
        'For the startup investigation only, read startup-probe.txt. This dummy startup fixture represents a slow fallback path.',
        "Before requesting user authorization, verify enforcement by making one real shell attempt through default sandbox: /bin/sh -c 'printf PRE_APPROVAL_PROBE > startup-probe.txt'. It must fail because the workspace is read-only. Do not try alternate writes.",
        'After recording your finding, request exactly one tool approval from the user. Use the shell execution tool with sandbox_permissions require_escalated and justification "启动调查已确认慢路径，是否允许只修改测试文件 startup-probe.txt？". The ONE command to request approval for is: /bin/sh -c \'printf STARTUP_WRITE_APPROVED > startup-probe.txt\'. This is an isolated fixture. Do not substitute an ordinary text message, orchestration ask, or another tool for this native approval. Wait for the human.',
        'If Orca says the approval was interrupted, do not treat it as a refusal and do not finish the task. Wait for new guidance. If the human asks to renew the approval, request the exact same native tool operation again and wait for the new decision.',
        ...(process.env.ORCA_DISPATCH_MANUAL_RENEW === '1'
          ? [
              'For this particular QA run, on resuming an interrupted turn after Orca restarts, even when automatically prompted to continue, do not make any tool call or file edit and do not submit a task result until you receive a dispatch mailbox pointer. End only that reply with a short message that you are waiting for approval renewal. On receipt of the mailbox pointer, read the mail and follow the renewal instruction. This condition applies only after the turn was interrupted, after your first native approval attempt.'
            ]
          : []),
        "If the human refuses, never request approval again. Make one more default-sandbox shell probe, /bin/sh -c 'printf POST_DENY_PROBE > startup-probe.txt', to prove denial preserved read-only access. Then report the findings.",
        'If the human allows the requested tool, verify the exact marker in startup-probe.txt, leave all other files untouched, and report completion.',
        ''
      ].join('\n')
    )
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
    git('init', '-b', 'main')
    git('add', '.')
    git(
      '-c',
      'user.name=Orca QA',
      '-c',
      'user.email=orca-qa@example.invalid',
      'commit',
      '-m',
      'isolated approval fixture'
    )
    let active: Awaited<ReturnType<typeof restart.launch>>['app'] | undefined
    try {
      const first = await restart.launch()
      active = first.app
      const firstPid = first.app.process().pid
      const providerHome = await first.app
        .evaluate(({ app }) => app.getPath('home'))
        .then((home) => join(home, '.codex'))
      await mkdir(providerHome, { recursive: true, mode: 0o700 })
      await copyFile(process.env.ORCA_DISPATCH_PROBE_CODEX_AUTH!, join(providerHome, 'auth.json'))
      await chmod(join(providerHome, 'auth.json'), 0o600)
      await writeFile(join(providerHome, 'config.toml'), 'model_reasoning_effort = "low"\n')
      await setupView(first.page)
      expect(
        await first.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((w) => w.isVisible() || w.isFocused())
        )
      ).toBe(false)
      const group = await first.page.evaluate(
        async ({ repo, workspaceDir }) => {
          const st = window.__store!.getState()
          await st.updateSettingsOrThrow({
            workspaceDir,
            defaultTuiAgent: 'codex',
            nativeChatProviders: { codex: true },
            nativeChatPermissionMode: 'auto',
            agentPermissionDefault: 'auto',
            agentCmdOverrides: { codex: '/opt/homebrew/bin/codex' },
            decisionModel: { source: 'agent', agent: 'codex' }
          })
          const added = await window.api.repos.add({ path: repo })
          if ('error' in added) {
            throw new Error(added.error)
          }
          await st.fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
          await st.fetchWorktrees(added.repo.id)
          return added.repo.id
        },
        { repo, workspaceDir }
      )
      console.log('QA restart ready', { branch, profile: restart.userDataDir, root, firstPid })
      const pane = await openEntry(first.page)
      await pane.locator('textarea[name=request]').fill(request)
      await pane.locator('textarea[name=request]').press('Enter')
      await expect(pane.getByRole('article')).toHaveCount(2, { timeout: 55_000 })
      const startup = pane.getByRole('article', { name: /启动/ })
      await expect(startup.getByRole('button', { name: /^(Allow|允许)$/ })).toBeVisible({
        timeout: 80_000
      })
      const [before, beforeApprovals] = await readFacts(first.page, group)
      const input = before.inputs[0]
      const original = input.subActions.find((a) => /启动/.test(a.subAction.text))
      const login = input.subActions.find((a) => /登录/.test(a.subAction.text))
      const approval = beforeApprovals.approvals?.find(
        (a) => a.dispatchId === original.execution.dispatchId
      )
      expect(approval?.detail ?? approval?.title).toBeTruthy()
      const initial = await readProbe(providerHome, marker)
      console.log('QA pending approval', {
        branch,
        id: approval.approvalId,
        dispatchId: original.execution.dispatchId
      })
      expect(initial).toMatchObject({ denied: true, permission: 'read-only' })
      const probePath = join(initial!.cwd, 'startup-probe.txt')
      expect(await readFile(probePath, 'utf8')).toBe('STARTUP_ORIGINAL\n')
      await first.page.screenshot({ path: join(out, `${branch}-01-pending-before-restart.png`) })
      console.log('QA ready to restart', {
        branch,
        dispatch: original.execution.dispatchId,
        approval: approval.approvalId
      })
      if (!control) {
        await restart.close(first.app)
        active = undefined
      }

      const second = control ? first : await restart.launch()
      active = second.app
      await setupView(second.page)
      if (!control) {
        expect(second.app.process().pid).not.toBe(firstPid)
      }
      expect(
        await second.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((w) => w.isVisible() || w.isFocused())
        )
      ).toBe(false)
      const restore = second.page.getByRole('button', {
        name: /^(恢复 \d+ 个聊天|Reconnect \d+ Chats?|Restore \d+ Chats?)$/i
      })
      if (!control) {
        await restore.waitFor({ timeout: 5_000 }).catch(() => {})
      }
      if (await restore.isVisible()) {
        await second.page.screenshot({ path: join(out, `${branch}-reconnect-dialog.png`) })
        await restore.click()
      }
      const reopened = await openEntry(second.page)
      const originalCard = reopened.getByRole('article', { name: /启动/ })
      await expect(originalCard).toBeVisible()
      const renew = originalCard.getByRole('button', {
        name: /^(Request approval again|重新发起审批)$/
      })
      const matchingApproval = async () => {
        const [, approvals] = await readFacts(second.page, group)
        return (
          approvals.approvals?.find(
            (item) =>
              item.dispatchId === original.execution.dispatchId &&
              item.detail?.includes(allowedValue) &&
              (item.interrupted || item.approvalId !== approval.approvalId)
          ) ?? null
        )
      }
      await expect.poll(matchingApproval, { timeout: 25_000 }).toBeTruthy()
      const [after] = await readFacts(second.page, group)
      const restoredInput = after.inputs.find((i) => i.input.input_id === input.input.input_id)
      const restored = restoredInput?.subActions.find(
        (a) => a.subAction.sub_action_id === original.subAction.sub_action_id
      )
      expect(restored?.execution?.dispatchId).toBe(original.execution.dispatchId)
      const restoredPrompt = await matchingApproval()
      expect(restoredPrompt).toBeTruthy()
      if (process.env.ORCA_DISPATCH_MANUAL_RENEW === '1') {
        expect(restoredPrompt.interrupted).toBe(true)
      }
      expect(await readFile(probePath, 'utf8')).toBe('STARTUP_ORIGINAL\n')
      console.log('QA original card approval after restart', {
        branch,
        approvalId: restoredPrompt.approvalId,
        interrupted: restoredPrompt.interrupted
      })
      await second.page.screenshot({
        path: join(out, `${branch}-02-original-card-after-restart.png`)
      })
      let freshApprovalId: string | null = restoredPrompt.interrupted
        ? null
        : restoredPrompt.approvalId
      if (branch === 'allow' && restoredPrompt.interrupted) {
        await renew.click()
        await expect
          .poll(
            async () => {
              const [, approvals] = await readFacts(second.page, group)
              freshApprovalId =
                approvals.approvals?.find(
                  (item) =>
                    item.dispatchId === original.execution.dispatchId &&
                    !item.interrupted &&
                    item.approvalId !== approval.approvalId &&
                    item.detail?.includes(allowedValue)
                )?.approvalId ?? null
              return freshApprovalId
            },
            { timeout: 55_000 }
          )
          .toBeTruthy()
        expect(await readFile(probePath, 'utf8')).toBe('STARTUP_ORIGINAL\n')
        await second.page.screenshot({
          path: join(out, 'allow-03-new-native-prompt-before-confirmation.png')
        })
      }
      const action = originalCard.getByRole('button', {
        name: branch === 'allow' ? /^(Allow|允许)$/ : /^(Deny|拒绝)$/
      })
      await expect(action).toBeVisible({ timeout: 10_000 })
      const canAnswer = true
      await action.click()
      const didClick = true
      let verifiedExecution = false
      if (didClick) {
        try {
          await expect
            .poll(
              async () =>
                branch === 'allow'
                  ? (await readFile(probePath, 'utf8')) === allowedValue
                  : (await readProbe(providerHome, marker))?.postDenyDenied === true,
              { timeout: 45_000, intervals: [250, 500, 1000] }
            )
            .toBe(true)
          verifiedExecution = true
        } catch {}
      }
      const [final, finalApprovals] = await readFacts(second.page, group)
      const startupAfter = final.inputs[0]?.subActions.find(
        (a) => a.subAction.sub_action_id === original.subAction.sub_action_id
      )
      const filesChanged = await readFile(probePath, 'utf8')
      const configFiles = (await paths(workspaceDir)).filter((f) =>
        f.endsWith('/fixture-config.json')
      )
      const configIntact =
        (await readFile(join(repo, 'fixture-config.json'), 'utf8')) === config &&
        configFiles.length >= 2 &&
        (await Promise.all(configFiles.map((f) => readFile(f, 'utf8')))).every(
          (value) => value === config
        )
      const error = (await reopened.getByRole('alert').allTextContents()).join(' ')
      const receipt = {
        branch,
        control,
        request,
        actualProcessRestart: { before: firstPid, after: second.app.process().pid },
        decision: JSON.parse(input.input.decision_json),
        split: input.subActions.map((a) => a.subAction.text),
        original: {
          inputId: input.input.input_id,
          taskId: original.subAction.task_id,
          dispatch: original.execution.dispatchId,
          approvalId: approval.approvalId,
          turn: initial!.turn
        },
        loginDispatch: login.execution?.dispatchId,
        restoredOriginalCard: true,
        preApproval: {
          sandbox: initial!.permission,
          writeDenied: initial!.denied,
          initialBytes: 'STARTUP_ORIGINAL\n'
        },
        afterRestart: {
          status: restored.execution.status,
          approvalFound: !!restoredPrompt,
          approvalButtonVisible: canAnswer,
          interrupted: restoredPrompt.interrupted,
          recoveredPromptId: restoredPrompt.approvalId
        },
        freshApprovalId,
        answer: {
          didClick,
          error,
          observedExpectedFileBehavior: verifiedExecution,
          verifiedExecution: verifiedExecution && !error,
          fileAfter: filesChanged,
          finalStatus: startupAfter?.execution?.status,
          promptCountAfter: finalApprovals.approvals?.length
        },
        configIntact
      }
      await second.page.screenshot({ path: join(out, `${branch}-03-answer-outcome.png`) })
      await writeFile(join(out, `${branch}-receipt.json`), `${JSON.stringify(receipt, null, 2)}\n`)
      console.log('QA branch result', receipt)
      expect(configIntact).toBe(true)
      expect(receipt.answer.verifiedExecution).toBe(true)
    } finally {
      await restart.dispose(active)
      await rm(root, { recursive: true, force: true })
    }
  })
}
