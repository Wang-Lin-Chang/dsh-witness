// detach-runner.cjs —— 可恢复执行的进程托管包装（EXP-1 判决产物 + 锁文件协议实装）
// 被 detached spawn（node 子进程 detached 存活 ✅），托管 powershell：
//   powershell 用 pipe stdio（可靠，fd stdio 会静默丢输出）→ 转发到输出文件 → 退出码写 exit 文件
// 锁文件协议（Witness 范式三证据之一）：
//   · 启动时创建 spawnDir/lock（内容 "pid:startTimeTicks"）——"我是谁"的旁证（DB 之外第二真相）
//   · 每 60s touch 锁 mtime（静默任务保护：观测式心跳；走预打开 fd，deny 后不查 ACL）
//   · powershell 正常退出 → 守卫句柄级删锁文件（完成信号：收养时锁在 = 未正常完成）
//   · 崩溃 → 锁残留但内容可读（收养判定读 pid+starttime）
// 沙箱 v5 受限执行（四轮实测判决闭合：守卫循环根因 + C5+守卫全链路）：
//   · lock 核心防护（C5-readonly-denyWA）：打破继承 + allow 读位含 ReadPermissions + deny WriteAttributes + 只读
//     —— 实测铁证：4/4 删除路径全挡（PowerShell 强删 / node unlink / node rmSync force / cmd del /f），
//        覆盖/追加/清只读全挡；allow 含 ReadPermissions 保证任务/Witness 读不伤
//   · 守卫（open-before-deny 最终形态）：deny 前 P/Invoke 开 lock 的 GENERIC_ALL 句柄，
//     正常退出经句柄 SetFileInformationByHandle(FileDispositionInfo=4) 删除 lock（完成信号）；
//     runner 崩溃 → 守卫退出不删（lock 残留，收养判定可读）
//   · 读 EPERM 悬案闭合（实测判决）：守卫循环用 `$sig -ne ''` 判定，
//     Get-Content 空文件 -Raw 返回 $null，$null -ne '' = True → 守卫误 break → 提前删 lock →
//     lock 变 pending-delete（lockFd 仍持有）→ 读 EPERM + stat ok + existsSync false 五症状全部吻合。
//     修复：[string]::IsNullOrEmpty 判定——守卫只在 sig 真写入后 break
//   · 诚实边界（实测判决）：out.log 删除防不住（任务删自己输出=自损）；任务 P/Invoke（Add-Type 任意代码）
//     可开 WRITE_DAC 自救 lock——owner 隐式权限，同用户物理边界；任意代码层需受限 token（v6）
// 用法: node detach-runner.cjs <spawnDir> <outFile> <exitFile> <commandBase64>
const { spawn } = require('node:child_process')
const fs = require('node:fs')

const [spawnDir, outFile, exitFile, cmdB64] = process.argv.slice(2)
if (!spawnDir || !outFile || !exitFile || !cmdB64) { process.exit(2) }
const cmd = Buffer.from(cmdB64, 'base64').toString('utf-8')

// ---- 锁文件协议：创建（O_EXCL 独占 = 防双 runner 同目录）----
const lockFile = `${spawnDir}\\lock`
function procStartSec() {
  try {
    const r = require('node:child_process').spawnSync('powershell', ['-NoProfile', '-Command', `[int](Get-Date -Date (Get-Process -Id ${process.pid}).StartTime.ToUniversalTime() -UFormat %s)`], { timeout: 5000, windowsHide: true })
    return Number(r.stdout.toString('utf-8').trim()) || 0
  } catch { return 0 }
}
let lockCreated = false
try {
  fs.writeFileSync(lockFile, `${process.pid}:0`, { flag: 'wx' })   // wx = O_EXCL 独占；lock 立即存在（收养观测窗口）
  lockCreated = true
} catch { /* 锁已存在：双 runner 防御（不该发生，保守继续） */ }
let myStartSec = 0
if (lockCreated) { try { myStartSec = procStartSec(); fs.writeFileSync(lockFile, `${process.pid}:${myStartSec}`) } catch {} }   // startSec 补写（超时降级 0）

// ---- open-before-deny：预打开证据 fd（deny 后已打开句柄的写不再检查 ACL）----
const outFd = fs.openSync(outFile, 'a')
let lockFd = -1
if (lockCreated) { try { lockFd = fs.openSync(lockFile, 'a') } catch {} }
try { fs.writeFileSync(exitFile, '', { flag: 'wx' }) } catch {}   // 预创建 exit.txt（防任务抢建伪造；wx 防覆盖已有）
const exitFd = fs.openSync(exitFile, 'a')

// ---- 守卫协议通道（预创建，守卫/runner 写内容不受任务干扰）----
const readyFile = `${spawnDir}\\.guard-ready`
const sigFile = `${spawnDir}\\.guard-restore`
try { fs.writeFileSync(readyFile, '', { flag: 'wx' }) } catch {}
try { fs.writeFileSync(sigFile, '', { flag: 'wx' }) } catch {}
const q = (p) => `'${p.replace(/'/g, "''")}'`

// ---- 守卫：deny 前打开 lock 的 GENERIC_ALL 句柄；sig 真写入 → 句柄级删除；runner 死 → 退出不删 ----
// 悬案修复：[string]::IsNullOrEmpty 判定（$null -ne '' 是 True 的经典坑——实测判决）
let guardReady = false
let guardDone = undefined
if (lockCreated) {
  const guardPs = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Guard {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateFile(string f, uint acc, uint share, IntPtr sa, uint disp, uint flags, IntPtr tpl);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetFileInformationByHandle(IntPtr h, int cls, IntPtr info, uint len);
}
public class Structs {
  [StructLayout(LayoutKind.Sequential)]
  public struct FILE_BASIC_INFO { public long CreationTime; public long LastAccessTime; public long LastWriteTime; public long ChangeTime; public uint FileAttributes; }
  [StructLayout(LayoutKind.Sequential)]
  public struct FILE_DISPOSITION_INFO { [MarshalAs(UnmanagedType.I1)] public bool DeleteFile; }
}
'@
$h = [Guard]::CreateFile(${q(lockFile)}, 0x10000000, 7, [IntPtr]::Zero, 3, 0x80, [IntPtr]::Zero)
$ok = ($h -ne [IntPtr]::Zero -and $h -ne [IntPtr]::MinusOne)
Set-Content -Path ${q(readyFile)} -Value "ok=$ok" -NoNewline
if (-not $ok) { Write-Output 'GUARD-OPEN-FAIL'; exit 1 }
while ($true) {
  $sig = Get-Content ${q(sigFile)} -Raw -ErrorAction SilentlyContinue
  if (-not [string]::IsNullOrEmpty($sig)) { break }
  if (-not (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue)) { break }   # runner 崩溃：退出不删（lock 残留 = 收养证据）
  Start-Sleep -Milliseconds 200
}
if ([string]::IsNullOrEmpty((Get-Content ${q(sigFile)} -Raw -ErrorAction SilentlyContinue))) { Write-Output 'GUARD-CRASH-PATH'; exit 0 }   # 崩溃路径：不删 lock
$bi = New-Object Structs+FILE_BASIC_INFO
$bi.FileAttributes = 0x80
$p1 = [Runtime.InteropServices.Marshal]::AllocHGlobal([Runtime.InteropServices.Marshal]::SizeOf($bi))
[Runtime.InteropServices.Marshal]::StructureToPtr($bi, $p1, $false)
[void][Guard]::SetFileInformationByHandle($h, 0, $p1, [Runtime.InteropServices.Marshal]::SizeOf($bi))
[Runtime.InteropServices.Marshal]::FreeHGlobal($p1)
$di = New-Object Structs+FILE_DISPOSITION_INFO
$di.DeleteFile = $true
$p2 = [Runtime.InteropServices.Marshal]::AllocHGlobal([Runtime.InteropServices.Marshal]::SizeOf($di))
[Runtime.InteropServices.Marshal]::StructureToPtr($di, $p2, $false)
$r = [Guard]::SetFileInformationByHandle($h, 4, $p2, [Runtime.InteropServices.Marshal]::SizeOf($di))
[Runtime.InteropServices.Marshal]::FreeHGlobal($p2)
[void][Guard]::CloseHandle($h)
if ($r) { Write-Output 'GUARD-DELETED' } else { Write-Output 'GUARD-DELETE-FAIL' }
`
  const guard = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', guardPs], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let guardOut = ''
  guard.stdout.on('data', (d) => { guardOut += d })
  guard.stderr.on('data', (d) => { guardOut += d })
  guardDone = new Promise(res => guard.on('exit', () => res(guardOut)))
  // 等守卫 ready（句柄已开，deny 才能开始）
  for (let i = 0; i < 100; i++) {
    try { if (fs.readFileSync(readyFile, 'utf-8').length > 0) { guardReady = true; break } } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }
}

// ---- 沙箱 v5：denyEvidence ----
function psOneLine(ps) {
  try { require('node:child_process').spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 8000 }) } catch { /* 降级：仅 cwd 限制 */ }
}
function denyEvidence() {
  const qq = (t) => `'${t.replace(/'/g, "''")}'`
  // 1) exit.txt：deny WD+AD（防伪造，不伤读，icacls 可恢复）
  let ps = `$a=Get-Acl ${qq(exitFile)};$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('Everyone','WriteData, AppendData','Deny')));Set-Acl ${qq(exitFile)} $a`
  // 2) lock + out.log：C5-readonly-denyWA（防删防改——验收 D-02 防删；allow 含 ReadPermissions 不伤读）
  //    （out.log 的 C5 化残留由 Witness 超龄清理/Persisted settle 清理的 R4 路径兜底）
  const c5 = (f) => `Set-ItemProperty ${qq(f)} IsReadOnly $true; $a=Get-Acl ${qq(f)}; $a.SetAccessRuleProtection($true,$false); $a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('Everyone','ReadData, ReadAttributes, ReadExtendedAttributes, ReadPermissions, Synchronize','Allow'))); $a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('Everyone','WriteAttributes','Deny'))); Set-Acl ${qq(f)} $a`
  ps += `; ${c5(outFile)}`
  if (lockCreated) ps += `; ${c5(lockFile)}`
  // 3) 目录 deny CreateFiles（防改名/新建：改名=目标创建，deny 后改名 FAIL；existsSync 误判的根因是守卫误触发
  //    的 pending-delete（实测判决），修复后目录 deny 不再误伤）
  ps += `; $a=Get-Acl ${qq(spawnDir)}; $a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('Everyone','CreateFiles','Deny'))); Set-Acl ${qq(spawnDir)} $a`
  psOneLine(ps)
}

// ---- 沙箱生效校验（P0-2 愈合：deny 静默失败的 fail-closed 防线）----
// 每个证据文件 deny ACE 数 >= 1（out/exit 的 WD+AD、lock 的 WA）；目录 deny CreateFiles 数 >= 1
function verifySandbox() {
  try {
    const qq = (t) => `'${t.replace(/'/g, "''")}'`
    const targets = [outFile, exitFile, ...(lockCreated ? [lockFile] : []), spawnDir]
    const ps = `Write-Output (${targets.map(t => `@((Get-Acl ${qq(t)}).Access | Where-Object {$_.AccessControlType -eq 'Deny'}).Count`).join(' + ')})`
    const r = require('node:child_process').spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000, windowsHide: true })
    const m = /^(\d+)$/.exec((r.stdout?.toString('utf-8') ?? '').trim())
    if (m === null) return false
    return Number(m[1]) >= targets.length   // 每个目标至少一条 deny
  } catch { return false }
}
function applySandboxWithVerification() {
  denyEvidence()
  if (verifySandbox()) return true
  denyEvidence()   // 重试一次（spawnSync 瞬时故障）
  return verifySandbox()
}
function failClosedSandbox() {
  // 沙箱失效：拒绝启动任务（安全第一）——EXIT:-998 = sandbox-degraded 协议
  try { fs.writeSync(exitFd, 'EXIT:-998') } catch {}
  try { fs.closeSync(exitFd) } catch {}
  try { fs.closeSync(outFd) } catch {}
  if (lockFd >= 0) { try { fs.closeSync(lockFd) } catch {} }
  clearInterval(touchTimer)
  try { fs.writeFileSync(sigFile, 'go') } catch {}   // 守卫删 lock（释放完成信号）
  process.exit(0)
}

// ---- 静默任务保护：每 60s touch 锁 mtime（走 fd：deny 后路径 utimes 会被 ACL 挡）----
const touchTimer = setInterval(() => {
  if (lockFd >= 0) { try { fs.utimesSync(lockFd, new Date(), new Date()) } catch {} }
}, 60000)

if (!applySandboxWithVerification()) failClosedSandbox()   // 先 deny 再 spawn：任务出生即受限
// 任务命令 UTF-8 输出前导（PowerShell 5.1 stdout 默认 OEM 代码页，中文输出会乱码进 out.log）
const taskCmd = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${cmd}`
const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-WorkingDirectory', spawnDir, '-Command', taskCmd], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  cwd: spawnDir,   // 沙箱 v5：工作目录限制 + lock C5 化 + 证据 deny WD+AD
})

child.stdout.on('data', (d) => { try { fs.writeSync(outFd, d) } catch {} })
child.stderr.on('data', (d) => { try { fs.writeSync(outFd, d) } catch {} })
// ---- 自救留痕检测（范式兜底）：任务退出后、守卫删 lock 前，校验 lock 内容 + ACL 结构 ----
// 任务任何有意义的伪造（改身份内容 / 自救 ACL）必然破坏其中之一；检测通过 = 证据链完好
function lockTampered() {
  if (!lockCreated) return false
  try {
    // 内容校验：lock 必须仍是 runner 写下的 pid:startSec
    const content = fs.readFileSync(lockFile, 'utf-8').trim()
    if (content !== `${process.pid}:${myStartSec}`) return true
    // ACL 校验：C5 结构必须完好（deny WA=1 + allow 读位=1）——任务自救（移除 deny/恢复继承）必破坏结构
    const r = require('node:child_process').spawnSync('powershell', ['-NoProfile', '-Command', `$a=Get-Acl '${lockFile.replace(/'/g, "''")}'; $d=@($a.Access|?{$_.AccessControlType -eq 'Deny'}).Count; $al=@($a.Access|?{$_.AccessControlType -eq 'Allow'}).Count; Write-Output "$d,$al"`], { timeout: 5000, windowsHide: true })
    const m = /^(\d+),(\d+)$/.exec(r.stdout.toString('utf-8').trim())
    if (m === null) return true
    return !(Number(m[1]) === 1 && Number(m[2]) === 1)
  } catch { return true }
}
async function finish(code) {
  const tampered = lockTampered()   // 检测在守卫删 lock 之前（删了就无法取证）
  const finalCode = tampered ? -999 : (code ?? 1)   // -999 = tampered 协议码（Witness settle 判 tampered）
  try { fs.writeSync(exitFd, `EXIT:${finalCode}`) } catch {}   // 预打开 fd 写退出码（deny 不影响已打开句柄）
  try { fs.closeSync(exitFd) } catch {}
  try { fs.closeSync(outFd) } catch {}
  if (lockFd >= 0) { try { fs.closeSync(lockFd) } catch {} }
  clearInterval(touchTimer)
  // 恢复 exit 的 deny（icacls 可恢复）；out.log 的 C5 化保留（读 allow 不伤 settle 吸尾，清理器 R4 兜底）
  if (fs.existsSync(exitFile)) {
    try { require('node:child_process').spawnSync('icacls', [exitFile, '/remove:d', 'Everyone'], { windowsHide: true, timeout: 8000 }) } catch {}
  }
  // 恢复目录 deny CreateFiles（任务已死）：registry 终态落盘 autopsy.json 需要目录可写
  // （验收 C-02 铁证：deny 残留 → probe write EPERM → 尸检报告缺失）
  try { require('node:child_process').spawnSync('icacls', [spawnDir, '/remove:d', 'Everyone'], { windowsHide: true, timeout: 8000 }) } catch {}
  // 触发守卫删 lock（正常退出 = 释放锁完成信号）
  try { fs.writeFileSync(sigFile, 'go') } catch {}
  if (guardDone !== undefined) await Promise.race([guardDone, new Promise(r => setTimeout(r, 15000))])
  // 守卫可靠性兜底（P1-1 愈合）：守卫被杀/卡死时 lock 仍 C5 化残留——
  // R4 路径恢复（File.SetAccessControl 移除 deny+恢复继承，owner 隐式 WRITE_DAC）→ 清只读 → 删 lock
  try {
    let lockStatOk = true
    try { fs.statSync(lockFile) } catch { lockStatOk = false }
    if (lockStatOk) {
      const qq = `'${lockFile.replace(/'/g, "''")}'`
      require('node:child_process').spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `try { $a=Get-Acl ${qq}; $a.Access | Where-Object { $_.AccessControlType -eq 'Deny' } | ForEach-Object { [void]$a.RemoveAccessRule($_) }; $a.SetAccessRuleProtection($false,$false); [System.IO.File]::SetAccessControl(${qq}, $a); Set-ItemProperty ${qq} IsReadOnly $false -ErrorAction SilentlyContinue } catch {}`], { windowsHide: true, timeout: 8000 })
      try { fs.unlinkSync(lockFile) } catch {}
    }
  } catch {}
  // 兜底：exit.txt 被任务删除 → 重建退出码（deny 已恢复）
  try {
    const cur = fs.existsSync(exitFile) ? fs.readFileSync(exitFile, 'utf-8') : ''
    if (!/^EXIT:/.test(cur)) fs.writeFileSync(exitFile, `EXIT:${finalCode}`)
  } catch {}
  process.exit(0)
}
child.on('exit', (code) => { finish(code).catch(() => process.exit(0)) })
child.on('error', () => { finish(1).catch(() => process.exit(1)) })
