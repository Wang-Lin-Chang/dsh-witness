# dsh-witness

> Crash-surviving background jobs for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), where **the filesystem is the source of truth**. Cross-restart adoption, autopsy reports, sandboxed execution, event sourcing — battle-tested on Windows 11 NTFS.
>
> 给 DeepSeek Harness 的崩溃存活后台任务：**文件系统即真相源**。跨重启收养、尸检报告、沙箱执行、事件溯源——Windows 11 NTFS 实测。

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![ci](https://github.com/Wang-Lin-Chang/dsh-witness/actions/workflows/ci.yml/badge.svg)](https://github.com/Wang-Lin-Chang/dsh-witness/actions/workflows/ci.yml)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-4d6bfe)](https://github.com/topics/dsh-plugin)
[![topic: dsh](https://img.shields.io/badge/topic-dsh-4d6bfe)](https://github.com/topics/dsh)

## 为什么存在 / Why this exists

Harness 内核自带的后台 *jobs* 是 fire-and-forget 工具执行（能读输出、能杀，不能对话、不能跨崩溃收养）。真实环境里的长程会话踩过这些公开的坑：

| 公开的痛点 | dsh-witness 的答案 |
|---|---|
| Force-kill 丢弃未刷盘的 write-behind 尾部（[#483](https://github.com/deepseek-ai/deepseek-harness/discussions/483)）| **零缓冲。** 每次状态转移立即落盘——目录结构本身就是状态机。 |
| 一条损坏的日志事件让会话永久死亡、无修复路径（[#1593](https://github.com/deepseek-ai/deepseek-harness/discussions/1593)）| **双真相源。** 目录=真相；SQLite=可重建的只读索引缓存（游标+mtime 失效）。缓存坏了永远不挡恢复——从目录重建即可。 |
| 两个任务挤在一个文件夹互相覆盖；40 分钟长跑交付坏产物（第三方实测报告）| **每任务一个隔离目录** + O_EXCL 锁 + 每任务沙箱化 cwd。 |
| "恢复意味着知道最后完成的步骤和证明输出的证据"（专家建议）| **尸检报告。** 每任务 `autopsy.json`：死因、主证据、判决、死因代码。 |
| 调度任务静默失败、无审查路径 | **事件溯源。** `events/*.jsonl` 记录每个任务的 started/output/done/adopted/tampered。 |

## 谁适合用它 / Who is this for

- 在 DeepSeek Harness 里跑**长后台任务**（几分钟以上的构建、批处理、数据搬运），被"会话一死任务就死"坑过的人；
- 被 **force-kill 丢输出尾部**坑过的人——输出游标续读，跨重启不重不漏；
- 需要事后知道**任务到底怎么死的**的人——`autopsy.json` 尸检：死因、主证据、判决、死因代码；
- 需要**防伪造留痕**的人——任务自救改证据会被判 `tampered`，而不是被默默信任。

**不适合**：几秒就结束的短命令——官方内置 jobs 已经够用，不必上这套目录协议。

> Runs long background jobs that must survive session/process death, with an autopsy trail instead of silent failure. Not for one-shot quick commands — the built-in jobs suffice there.

## 真相源：任务目录解剖 / The truth source

每个任务一个目录，**状态就是目录结构的函数**：

```
jobs/
└── pwsh-1/                      # 一个任务 = 一个目录
    ├── state/
    │   ├── running              # 五态标记（任一时刻恰一个为主）
    │   ├── stopping
    │   ├── orphaned             # 崩溃残留（收养判定现场）
    │   ├── adopted              # 新会话已收养
    │   └── done                 # 终态（内容 = 退出码）
    ├── lock                     # O_EXCL 协调锁，内容 = pid:startSec
    ├── spec.json                # 任务规格（kind/label/startedAt）
    ├── out.log                  # 输出（游标续读）
    ├── exit.txt                 # 退出协议（EXIT:<code>）
    ├── autopsy.json             # 尸检报告（终态时生成）
    └── events/                  # 事件溯源
        ├── 0001-started.jsonl
        ├── 0002-output.jsonl
        └── 0003-done.jsonl
```

**三证据收养判定**：lock 内容（`pid:startSec`）+ 进程存活 + 进程启动时间比对（防 PID 复用）。任何时刻 kill -9，重启后新实例扫目录即可收养或结案。

## 你能得到什么 / What you get

- **跨重启收养**——状态机活在目录结构里。任何 force-kill 后，新的 registry 实例用三证据收养或终结每个任务。
- **尸检报告**——每个终态任务拿到 `autopsy.json`（死因、主证据、判决、死因代码 D-01…D-09）+ output 摘要事件。
- **沙箱执行**——Windows NTFS ACL 限制在任务 spawn **之前**应用：证据文件的覆盖/追加/改名/删除/伪造全被挡；守卫句柄删除 lock 作为完成信号；留痕检测（lock 内容+ACL 结构校验）把自救伪造标记为 `tampered`（`EXIT:-999`）。
- **游标续读输出**——`read(id)` 只返回新字节；游标跨重启持久，长输出不重不漏。
- **并发收养安全**——50 个独立进程竞争终结同一个孤儿，恰好产生一个终态（幂等 finalize + 原子状态标记）。
- **`wait`/`close` 生命周期**——轮询到终态；干净停掉监控定时器。

## 快速开始 / Quick start

```sh
dsh plugin --profile <name> add "github:Wang-Lin-Chang/dsh-witness#v0.2.0"
```

仓库提交了编译产物（`lib/`），git 安装无需构建步骤。

```ts
import { WitnessJobRegistry } from 'dsh-witness'

const reg = new WitnessJobRegistry(ctx, {
  jobsRoot: './data/witness-jobs',        // 真相源：每任务一个目录
  indexDbPath: './data/witness-index.db', // 可重建索引缓存
  adoptMonitorMs: 30000,                  // 收养扫描间隔
})

const id = reg.start({ kind: 'pwsh', label: 'long-task', command: 'Start-Sleep 60; Write-Output done' })
const snap = await reg.wait(id, 120000)   // → completed | failed | tampered
const output = reg.read(id)               // 游标式增量读
reg.close()                               // 停监控定时器
```

## 验收证据 / Acceptance evidence

`test/witness-final-test.ts` —— 12 场景 / 34 断言，连跑稳定全绿。实测环境：**Windows 11 Pro · Node 25.8 · PowerShell 5.1**。

| 类别 | 场景 | 断言 |
|---|---|---|
| 持久化 A | 重启存活 / 僵尸恢复（kill -9）/ 输出游标续读 / ID 不冲突 | 4 项 |
| 收养协调 B | 50 进程 O_EXCL 竞争恰一终态 / 跨会话收养 / 静默任务保护 / PID 复用防护 | 4 项 |
| 事件溯源 C | 事件日志完整有序 / 尸检报告生成 | 2 项 |
| 沙箱边界 D | 防覆盖 / 防删 | 2 项 |

自己跑：`node --experimental-strip-types test/witness-final-test.ts`

## 与官方 jobs 的关系 / vs. the built-in jobs

| | 官方 jobs | dsh-witness |
|---|---|---|
| 崩溃后 | 靠会话持久化（write-behind 有丢尾窗口）| 目录结构即真相，kill -9 后收养续命 |
| 终态证据 | 无 | autopsy.json 尸检 + 事件溯源 |
| 任务隔离 | 无目录级隔离 | 每任务独立目录+锁+沙箱 |
| 输出读 | 整体读 | 游标增量续读（跨重启） |
| 对话/引导 | 不能 | 不能（v0）——对话式后台 agent 是 dsh-anchor 的领地 |

## 诚实边界 / Honest boundaries

- **Windows-first。** 实测于 Windows 11 NTFS + PowerShell 5.1 + Node 25.8。Linux/macOS 需要移植：锁协议（O_EXCL+startSec）、沙箱（ACL→其他机制）、runner（detached node+PowerShell）目前都是 Windows 专属。**未实测的平台不声称支持。**
- **任意代码自救超出 ACL 层能力**——任务加载原生代码（P/Invoke）可以以文件属主身份自救 ACL。留痕检测把这种伪造变成可见的 `tampered` 判决而不是默默信任；任意代码层的完全限制是受限 token 的活（见官方 Harness 沙箱配方）。
- 任务永远可以毁掉自己的输出——那只会伤到它自己，并且证据链全程可见。

## 开发 / Development

```sh
npm run build   # tsc 编译 src → lib
npm test        # 运行 12 项验收（node --experimental-strip-types）
```

要求：Node ≥ 22.5（`node:sqlite`，实测 25.8）、Windows PowerShell 5.1。

## License

Apache-2.0
