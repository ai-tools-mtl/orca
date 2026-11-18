# P0 driver — optional-decision-routing targeted delivery

Validation driver for **P0** of `docs/reference/optional-decision-routing-plan.md` (§9):
「原轮能接收补充，结束后能明确拒收」 against a real local runtime + real Codex structured
worker, through the strict routing entry (`orchestration routing-supplement-send`).

## What it runs

| Scenario            | Acceptance condition (plan §9 P0)                                                                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 同一轮改变下一步 | gate command initiated, no reads yet → supplement delivered to the named active turn (typed receipt with turn id) → gate released → worker's first new task action reads `new.txt`, never `old.txt` (checked over projected history by `routing/first-action-verification`) |
| S2 原轮结束后拒收   | supplement sent with the original turn id after it ends — once while the session is idle, once while another turn runs. Both must return a typed refusal bound to the original turn; history must show the supplement text nowhere and no turn opened because of it         |
| S3 并行与结算后续接 | two independent tasks each get a Dispatch while the first still runs; both settle with retrievable results; an explicit follow-up to the settled Dispatch continues its lineage (`follow_up_of_dispatch_id`)                                                                |
| S4 重启查证         | worker-start accepted with a driver-chosen `--retry-request` UUID; runtime killed and re-served; `orchestration request-show --request` and `worker-show --dispatch` re-query the original request id and Dispatch                                                          |

## Prerequisites

- `pnpm build:cli` (driver runs `out/cli/index.js`)
- an authenticated `codex` binary on PATH (the worker is a real Codex structured session)
- headless runtime: the driver runs `orca serve --data-root <tmp>` with
  `ORCA_BACKGROUND_LAUNCH=1`; a `bin/orca` shim in the temp workdir lets the worker report
  `worker_done` against the same runtime.

## Run

```bash
pnpm build:cli && npx electron-vite build --mode e2e   # or let Playwright's global setup build
P0_ROUTING_RUN=1 node tests/tools/optional-decision-routing-p0/run.mjs [--keep]
```

The wrapper runs `tests/e2e/optional-decision-routing-p0.spec.ts` under the
`electron-headless` Playwright project, which owns the app launch, the isolated profile
and the retained user-data dir across the S4 restart. The spec links the real `~/.codex`
into the isolated home so the spawned codex workers authenticate. Without
`P0_ROUTING_RUN=1` the spec skips and the wrapper only prints instructions, so plain CI
never spawns real agents. Exit code 0 = every recorded condition passed.

Results of the latest validated run live in `RESULTS.md` beside this README.
