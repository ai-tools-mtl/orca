# P0 实跑结果 · feature/dispatch-routing（2026-11-17）

实施基线：`docs/reference/optional-decision-routing-plan.md` §9 P0。
驱动：`tests/e2e/optional-decision-routing-p0.spec.ts`（opt-in，经 `run.mjs` 运行；
`P0_ROUTING_AGENT=fake`（默认）| `codex`）。

## 结论：定向投递流程 13/13 全部通过

真实 headless 运行时（Playwright electron，隔离 profile）+ 真实 Codex 结构化会话适配器 +
journal 证据 + routing 账本 + 编排结算/续接/回执全链路。`P0_ROUTING_AGENT=fake` 为协议级
替身：讲真 app-server 线协议（NDJSON initialize/thread/turn/item 通知），按脚本确定性执行
门命令与文件读取（真实文件、真实分类器 commandActions、真实发起顺序），仅替换模型层。

## 逐条验收（方案 §9 P0）

| # | 条件 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| S1.1 | 放行前：门命令已发起且未发起任何文件读取 | PASS | journal 门命令 item sequence=7，无 read item |
| S1.2 | 补充收到针对原轮次的投递回执 | PASS | `{outcome:"delivered", expectedTurnId:"turn-1", turnId:"turn-1"}`，与原活动轮一致 |
| S1.3 | 首个新动作=读 new.txt，发起于放行后，全程未读 old.txt | PASS | 锚点=门命令（sequence 7），首个新动作 `read` sequence=8 路径 `<worktree>/new.txt`，全程无 old.txt 读取 |
| S1.4 | 任务结算（worker_done 报告新标记） | PASS | `status:"completed"` |
| S2.1 | 原轮开启并结算（轮次 ID 取自执行记录） | PASS | journal turn item `turn-1`，任务 completed |
| S2.2 | 会话空闲：取得绑定原轮的明确拒收 | PASS | `{outcome:"refused", expectedTurnId:"turn-1"}`（turn-not-active，不触 provider） |
| S2.3 | 另有活动轮：仍拒收并绑定原轮，未改投其他轮 | PASS | 同上，第二新轮 `turn-1'` 未收到补充 |
| S2.4 | 两次拒收后：会话无补充文本、无因它新开的轮次 | PASS | history 全文无补充文本 |
| S3.1 | 第一项运行中即提交另一项，两项各有 Dispatch | PASS | ctx_a / ctx_b 并行 ready |
| S3.2 | 两项结果分别可取回 | PASS | statusA/B 均 completed |
| S3.3 | 结算后 follow-up 归入同一谱系 | PASS | follow-up send 回执产生新 Dispatch，其 worker-show 指回原 Dispatch（follow_up_of） |
| S4.1 | 原 request ID 重启后可对账 | PASS | `orchestration.requestShow --request <驱动自选 UUID>` 返回受理状态 |
| S4.2 | 原 Dispatch 重启后仍可查证，不另起 Worker | PASS | 重启后 `worker-show --dispatch <原ID>` 沿用持久行 |

运行时证据（每轮留档）：`test-results/optional-decision-routing-*/p0-evidence.json`、
`fake-codex-trace.log`（Orca↔替身的完整线协议收发）。

## 已验证（单测/静态层）

- **三家结构化 agent 的定向投递全部实现**，统一经 `steerExpectedTurn`（Router 按 session
  所属 adapter 路由）：
  - Codex `steerExpectedCodexTurn`（原生 turn/steer 点名轮）；
  - Claude `steerExpectedClaudeTurn`（`translator.currentTurnId` 绑定 + priority `now`
    强制插队，`claude-structured-expected-steer.ts`）；
  - ACP 系（grok/opencode/omp…）`steerExpectedAcpTurn`（`lane.openTurnId` 绑定 +
    `turns.dispatch` 活跃时入 steers 队列，`acp-expected-steer.ts`）；
  - 均拒绝在命名轮不可证时写入（turn-not-active），绝不改投、绝不新开轮。
- 定向单测：codex 11/11 + claude 3/3（同名轮插队/异轮拒绝/无输入功拒绝）+ acp 3/3
  （运行中入队/空闲拒绝/异轮拒绝）。
- routing 账本迁移 v47 四表 + ledger 探针；`pnpm tc:node`、`pnpm tc:cli`、e2e tsc、oxlint 全绿；
  RPC catalog 已再生。修复过程中补齐：`StructuredAgentSessionAdapterRouter.steerExpectedTurn`
  转发（原 Router 不透传新可选方法 → unsupported）。

## 真实 codex 组合的限制（诚实记录）

`P0_ROUTING_AGENT=codex`（真实认证 CLI）多轮尝试均被上游配额挡住：
worker rollout `task_complete.error = usage_limit_exceeded`（"try again at 6:37 PM" 未如期重置，
21:23 仍复现）。轮次打开后模型调用即被拒，门命令无法发起——**路径本身未被证伪**，
该组合待额度恢复后复跑：`P0_ROUTING_AGENT=codex SKIP_BUILD=1 P0_ROUTING_RUN=1 node tests/tools/optional-decision-routing-p0/run.mjs`。

## 踩坑（实施记录）

- `agentSession.history` 结果在 `result.page.items`；无 CLI verb，E2E 里经 RuntimeClient 读。
- 结构化 worker 的命令覆盖须走 `settings.mutateAgentLaunch {type:'command'}`（renderer
  updateSettings 的 agentCmdOverrides 不进主进程启动链）；`orca serve` 开发仓不可用，
  必须走 Playwright electron 无头；隔离 home 会预建空 `.codex` 挡 auth 软链（EEXIST 需重建）。
- worker-start 就绪判定要求输入回显（`turn_start: observed`）：gate 轮必须先回 userMessage。
