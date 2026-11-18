# P0 实跑结果 · feature/dispatch-routing（2026-11-17 首验，2026-11-18 真实 codex 组合正式通过）

实施基线：`docs/reference/optional-decision-routing-plan.md` §9 P0。
驱动：`tests/e2e/optional-decision-routing-p0.spec.ts`（opt-in，经 `run.mjs` 运行；
`P0_ROUTING_AGENT=fake`（默认）| `codex` | `zcode`）。

## 结论：P0 正式门槛达成 — 真实 codex 组合 26 项全 PASS（2026-11-18）

§9 P0 要求「至少一种本地组合在同一条定向投递路径通过」。真实认证 codex CLI（配额恢复后）
在最终代码上跑通全部验收：同轮改向（门命令→补充投递→首动作读 new.txt→结算）、两态拒收、
并行与结算后续接、重启对账。fake 组合同样 13/13。方案 P0 关闭，可进入 A 阶段。

同时落地：首动作验证器支持 `expectedTurnId` 逐轮归属——补充回声必须落在被点名轮内、首个
任务动作只在该轮内判定（zcode 检查→发送间隙误投递由此显式判 violation，不再只是注释宣称）；
同一 supplement 的重试复用最近一次 attempt 的 request ID（方案 §6）。

真实 headless 运行时（Playwright electron，隔离 profile）+ 真实 Codex 结构化会话适配器 +
journal 证据 + routing 账本 + 编排结算/续接/回执全链路。`P0_ROUTING_AGENT=fake` 为协议级
替身：讲真 app-server 线协议（NDJSON initialize/thread/turn/item 通知），按脚本确定性执行
门命令与文件读取（真实文件、真实分类器 commandActions、真实发起顺序），仅替换模型层。

## 逐条验收（方案 §9 P0）

| #    | 条件                                                  | 结果 | 关键证据                                                                                               |
| ---- | ----------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| S1.1 | 放行前：门命令已发起且未发起任何文件读取              | PASS | journal 门命令 item sequence=7，无 read item                                                           |
| S1.2 | 补充收到针对原轮次的投递回执                          | PASS | `{outcome:"delivered", expectedTurnId:"turn-1", turnId:"turn-1"}`，与原活动轮一致                      |
| S1.3 | 首个新动作=读 new.txt，发起于放行后，全程未读 old.txt | PASS | 锚点=门命令（sequence 7），首个新动作 `read` sequence=8 路径 `<worktree>/new.txt`，全程无 old.txt 读取 |
| S1.4 | 任务结算（worker_done 报告新标记）                    | PASS | `status:"completed"`                                                                                   |
| S2.1 | 原轮开启并结算（轮次 ID 取自执行记录）                | PASS | journal turn item `turn-1`，任务 completed                                                             |
| S2.2 | 会话空闲：取得绑定原轮的明确拒收                      | PASS | `{outcome:"refused", expectedTurnId:"turn-1"}`（turn-not-active，不触 provider）                       |
| S2.3 | 另有活动轮：仍拒收并绑定原轮，未改投其他轮            | PASS | 同上，第二新轮 `turn-1'` 未收到补充                                                                    |
| S2.4 | 两次拒收后：会话无补充文本、无因它新开的轮次          | PASS | history 全文无补充文本                                                                                 |
| S3.1 | 第一项运行中即提交另一项，两项各有 Dispatch           | PASS | ctx_a / ctx_b 并行 ready                                                                               |
| S3.2 | 两项结果分别可取回                                    | PASS | statusA/B 均 completed                                                                                 |
| S3.3 | 结算后 follow-up 归入同一谱系                         | PASS | follow-up send 回执产生新 Dispatch，其 worker-show 指回原 Dispatch（follow_up_of）                     |
| S4.1 | 原 request ID 重启后可对账                            | PASS | `orchestration.requestShow --request <驱动自选 UUID>` 返回受理状态                                     |
| S4.2 | 原 Dispatch 重启后仍可查证，不另起 Worker             | PASS | 重启后 `worker-show --dispatch <原ID>` 沿用持久行                                                      |

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

## zcode 组合（2026-11-18 合并 origin/feature/zcode-chat 后）

- zcode 结构化 adapter 随合并进入本线（src/main/zcode/structured/**，已注册进
  STRUCTURED_AGENT_RUNTIME_CATALOG）。
- `steerExpectedZcodeTurn`（session-lifecycle/zcode-structured-session-steer.ts）：
  zcode 后端自带 steer 语义——`session/send` 在轮运行期间被后端排入 steer 队列并随
  `turn.steerDrained` 注入当前轮；严格入口在 `lane.openTurnId === expectedTurnId` 时才发送，
  否则 turn-not-active 拒绝（协议无 expected-turn 字段，检查→发送间隙的轮切换由
  routing 账本的逐轮动作归因事后捕捉）。单测 3/3。
- E2E 已参数化（`P0_ROUTING_AGENT=zcode`，直跑真实 CLI + 真实账户模型）。基础设施链路
  已全部修通并实测（2026-11-18）：provider-exec bootstrap（status→ownership→gate→pid 发布）
  → worker `ready` → dispatch preamble 投递接受（turnStart observed）→ journal 投影 user
  message + turn。修复的三个产品 bug：
  1. `zcode-structured-start` 未转发 `launch.envToDelete` → 桌面全套 `ZCODE_*`（含
     `ZCODE_SESSION_ID`/endpoint socket）经 managed spawn 的 process-env merge 复活，后端
     以受管桌面模式自启；
  2. `zcodeStructuredLaunchPart` 的删除清单未豁免 `providerEnv`（`zcodeDesktopEnvKeys`
     缺 launchEnv 实参）→ 启动层自设的 builtin/personal provider 表键被 post-merge 删除，
     CLI 报「无法定位 Built-in Provider Config」拒启；
  3. zcode 连接的 `onSpawned` 用一次性同步 `child.pid` 检查，而 pid 在 bootstrap 握手后才
     发布 → 永远错过（codex 用 `awaitProviderChildSpawn` 等待，已对齐）。
  - E2E 需将真实 `~/.zcode` 软链进隔离 home（同 `~/.codex` 信任模型），CLI 才有个人
    provider 配置与账户状态。
  4. Orca 的 v2 凭据读取器只认 `enc:v1:`，而当前桌面写入 `enc:v2:os:`（OS keystore 密钥，
     service「ZCode Credential Encryption」，account=sha256(credentials.json 路径) hex）；已实现
     跨平台 v2:os 解密（macOS keychain via `security`、Windows Credential Manager via 内置
     PowerShell CredRead、Linux Secret Service 待接）+ `ZCODE_CREDENTIAL_SECRET(_FILE)`/
     credential-secret 文件源 + OAuth access_token 回退 + `interaction/requestCredentialCipher`
     加解密桥（CLI 把自己凭据存储的加解密委托给宿主，无头 Orca 现在能承接）。
     Windows 侧为按 CLI 契约的实现（napi-rs keyring 同款 CredRead），尚需真机冒烟。
- 剩余卡点（根因已定位，边界在 zcode CLI/桌面契约）：worker 就绪后轮次启动
  （`prompt_started`、executionStartedAt 有值）但网关调用挂死——CLI 从不请求
  provider-headers/凭证桥，且手动驱动实验（plain / 官方 token / 桌面 endpoint socket
  三变体）全部 accepted-但-零输出。结论：当前 zcode CLI 的网关传输依赖桌面 endpoint
  代理服务的完整协议，独立（headless）传输要么不存在要么需要桌面侧更多握手。要打通需
  zcode CLI 提供独立传输契约，或 Orca 实现桌面 endpoint 代理协议（规模远超本轮）。
  路由侧 S1 已推进到「等待门命令」一步；fake 组合在全部修复后回归 13/13。

## 真实 codex 组合的限制（诚实记录）

`P0_ROUTING_AGENT=codex`（真实认证 CLI）多轮尝试均被上游配额挡住：
worker rollout `task_complete.error = usage_limit_exceeded`（"try again at 6:37 PM" 未如期重置，
21:23 仍复现）。轮次打开后模型调用即被拒，门命令无法发起——**路径本身未被证伪**，
该组合待额度恢复后复跑：`P0_ROUTING_AGENT=codex SKIP_BUILD=1 P0_ROUTING_RUN=1 node tests/tools/optional-decision-routing-p0/run.mjs`。

## 合并后环境回归（已修复，2026-11-18 复验 13/13 全绿）

合并 origin/feature/zcode-chat（基于更新的 main）后，worker 启动环境解析变化：
`agentCmdOverrides`/`agentDefaultEnv` 注入不再到达 worker 子进程 spawn（诊断证据：
p0-debug.log + codex-shim.log——13228 次 --version 探测走 shim、0 次 app-server、
hook-trust 写子 stdin EPIPE、`codex app-server started without a pid`）。

修复（commit 89fd41e0bc1）：隔离 home 的登录 shell PATH 止于 /usr/bin:/bin，真 CLI wrapper
（`#!/usr/bin/env node`）找不到 node——经 `agentDefaultEnv` 给 codex/zcode/claude 预置
node 目录；命令覆盖统一走 `settings.mutateAgentLaunch`；fake 模式补上 `WORKER_AGENT`
映射（launch/dispatch 仍编址 codex，'fake' 不是合法 agent id）。复验：
`P0_ROUTING_AGENT=fake` 13/13 PASS（11.5s），与 2026-11-17 首验一致。

## 踩坑（实施记录）

- `agentSession.history` 结果在 `result.page.items`；无 CLI verb，E2E 里经 RuntimeClient 读。
- 结构化 worker 的命令覆盖须走 `settings.mutateAgentLaunch {type:'command'}`（renderer
  updateSettings 的 agentCmdOverrides 不进主进程启动链）；`orca serve` 开发仓不可用，
  必须走 Playwright electron 无头；隔离 home 会预建空 `.codex` 挡 auth 软链（EEXIST 需重建）。
- worker-start 就绪判定要求输入回显（`turn_start: observed`）：gate 轮必须先回 userMessage。
