# dsh-witness

> Crash-surviving background jobs for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), where **the filesystem is the source of truth**. Cross-restart adoption, autopsy reports, sandboxed execution, event sourcing — battle-tested on Windows 11 NTFS.

中文版见 [README.zh-CN.md](./README.zh-CN.md)。

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![ci](https://github.com/Wang-Lin-Chang/dsh-witness/actions/workflows/ci.yml/badge.svg)](https://github.com/Wang-Lin-Chang/dsh-witness/actions/workflows/ci.yml)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-4d6bfe)](https://github.com/topics/dsh-plugin)
[![topic: dsh](https://img.shields.io/badge/topic-dsh-4d6bfe)](https://github.com/topics/dsh)

## Why this exists

The harness's built-in background *jobs* are fire-and-forget tool executions (readable output, killable, but no conversation and no cross-crash adoption). Long-running sessions in real environments hit these public pain points:

| Public pain point | dsh-witness's answer |
|---|---|
| Force-kill drops the unflushed write-behind tail ([#483](https://github.com/deepseek-ai/deepseek-harness/discussions/483)) | **Zero buffering.** Every state transition lands on disk immediately — the directory structure itself is the state machine. |
| One corrupted log event kills a session permanently, with no repair path ([#1593](https://github.com/deepseek-ai/deepseek-harness/discussions/1593)) | **Two sources of truth.** Directory = truth; SQLite = a rebuildable read-only index cache (cursor + mtime invalidation). A broken cache never blocks recovery — rebuild it from the directory. |
| Two jobs sharing one folder overwrite each other; a 40-minute run delivers a broken artifact (third-party measured report) | **One isolated directory per job** + O_EXCL lock + sandboxed cwd per job. |
| "Recovery means knowing the last completed step and the evidence proving the output" (expert advice) | **Autopsy reports.** Per-job `autopsy.json`: cause of death, primary evidence, verdict, death code. |
| Scheduled jobs fail silently with no review path | **Event sourcing.** `events/*.jsonl` records started/output/done/adopted/tampered for every job. |

## Who is this for

- People who run **long background jobs** on DeepSeek Harness (multi-minute builds, batch processing, data moves) and have been bitten by "session dies, job dies";
- People bitten by **force-kill output-tail loss** — cursor-based incremental reads, no repeats or gaps across restarts;
- People who need to know **how a job actually died** — `autopsy.json`: cause, primary evidence, verdict, death code;
- People who need **tamper-evident trails** — a job that tampers with its own evidence is judged `tampered`, not silently trusted.

**Not for**: one-shot quick commands — the built-in jobs suffice there.

## The truth source: job directory anatomy

One directory per job — **state is a function of the directory structure**:

```
jobs/
└── pwsh-1/                      # one job = one directory
    ├── state/
    │   ├── running              # five-state markers (exactly one active at a time)
    │   ├── stopping
    │   ├── orphaned             # crash residue (adoption adjudication site)
    │   ├── adopted              # adopted by a new session
    │   └── done                 # terminal state (content = exit code)
    ├── lock                     # O_EXCL coordination lock, content = pid:startSec
    ├── spec.json                # job spec (kind/label/startedAt)
    ├── out.log                  # output (cursor-based incremental reads)
    ├── exit.txt                 # exit protocol (EXIT:<code>)
    ├── autopsy.json             # autopsy report (generated at terminal state)
    └── events/                  # event sourcing
        ├── 0001-started.jsonl
        ├── 0002-output.jsonl
        └── 0003-done.jsonl
```

**Three-evidence adoption adjudication**: lock content (`pid:startSec`) + process liveness + process start-time comparison (PID-reuse guard). Kill -9 at any moment; after restart, a new instance scans the directory and adopts or closes each job.

## What you get

- **Cross-restart adoption** — the state machine lives in the directory structure. After any force-kill, a new registry instance adopts or finalizes each job via the three-evidence rule.
- **Autopsy reports** — every terminal job gets `autopsy.json` (cause, primary evidence, verdict, death code D-01…D-09) plus output-summary events.
- **Sandboxed execution** — Windows NTFS ACLs are applied **before** the job spawns: overwrite/append/rename/delete/forge of evidence files are all blocked; the guard handle's lock deletion is the completion signal; tamper detection (lock content + ACL structure checks) marks self-rescue forgeries as `tampered` (`EXIT:-999`).
- **Cursor-based incremental output** — `read(id)` returns only new bytes; the cursor persists across restarts; long outputs are read without repeats or gaps.
- **Concurrent adoption safety** — 50 independent processes racing to finalize one orphan produce exactly one terminal state (idempotent finalize + atomic state marker).
- **`wait`/`close` lifecycle** — poll to terminal state; cleanly stop the monitor timer.

## Quick start

```sh
dsh plugin --profile <name> add "github:Wang-Lin-Chang/dsh-witness#v0.2.0"
```

The repo ships compiled output (`lib/`), so git installs need no build step.

```ts
import { WitnessJobRegistry } from 'dsh-witness'

const reg = new WitnessJobRegistry(ctx, {
  jobsRoot: './data/witness-jobs',        // truth source: one directory per job
  indexDbPath: './data/witness-index.db', // rebuildable index cache
  adoptMonitorMs: 30000,                  // adoption scan interval
})

const id = reg.start({ kind: 'pwsh', label: 'long-task', command: 'Start-Sleep 60; Write-Output done' })
const snap = await reg.wait(id, 120000)   // → completed | failed | tampered
const output = reg.read(id)               // cursor-based incremental read
reg.close()                               // stop the monitor timer
```

## Acceptance evidence

`test/witness-final-test.ts` — 12 scenarios / 34 assertions, stable green on repeated runs. Measured on **Windows 11 Pro · Node 25.8 · PowerShell 5.1**.

| Category | Scenario | Assertions |
|---|---|---|
| Persistence A | Survives restart / zombie recovery (kill -9) / cursor-based output read / ID collision-free | 4 |
| Adoption coordination B | 50-process O_EXCL race yields exactly one terminal state / cross-session adoption / silent-job protection / PID-reuse guard | 4 |
| Event sourcing C | Event log complete and ordered / autopsy report generated | 2 |
| Sandbox boundary D | Overwrite-proof / delete-proof | 2 |

Run it yourself: `node --experimental-strip-types test/witness-final-test.ts`

## vs. the built-in jobs

| | Built-in jobs | dsh-witness |
|---|---|---|
| After a crash | Session persistence (write-behind has a tail-loss window) | Directory structure is the truth; adoption continues after kill -9 |
| Terminal evidence | None | autopsy.json + event sourcing |
| Job isolation | No directory-level isolation | One directory per job + lock + sandbox |
| Output reads | Whole-output read | Cursor-based incremental reads (across restarts) |
| Conversation/guidance | No | No (v0) — conversational background agents are dsh-anchor's domain |

## Honest boundaries

- **Windows-first.** Measured on Windows 11 NTFS + PowerShell 5.1 + Node 25.8. Linux/macOS needs porting: the lock protocol (O_EXCL+startSec), the sandbox (ACL → other mechanisms), and the runner (detached node + PowerShell) are all Windows-specific today. **Untested platforms are not claimed.**
- **Arbitrary-code self-rescue is beyond the ACL layer** — a job that loads native code (P/Invoke) can rescue its own ACLs as the file owner. Tamper detection turns such forgery into a visible `tampered` verdict instead of silent trust; fully restricting arbitrary code is restricted-token territory (see the official harness sandbox recipes).
- A job can always destroy its own output — that only hurts itself, and the evidence trail stays visible end to end.

## Development

```sh
npm run build   # tsc: src → lib
npm test        # 12 acceptance scenarios (node --experimental-strip-types)
```

Requires: Node ≥ 22.5 (`node:sqlite`, measured on 25.8), Windows PowerShell 5.1.

## License

Apache-2.0
