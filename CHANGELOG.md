# Changelog

All notable changes to dsh-witness are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-08-26

### Changed

- 语言合规清扫：runner 注释与 README 措辞；README 双语分文件（README.md 英文 + README.zh-CN.md 中文）。12 项验收 / 34 断言不变。

## [0.2.0] - 2026-08-16

### Added

- EXPERIMENTS.md — experiment ledger: lock-file protocol, three-evidence adoption, O_EXCL race, index cache, ACL sandbox, cursor reads, 12-item acceptance, adoption-latency benchmark (EXP-1~EXP-8).
- Platform backend matrix in README (Linux via dsh-cross-platform, macOS via dsh-macos).
- Plugin suite banner.

### Fixed

- Word hygiene across public files.

## [0.1.0] - 2026-08-15

### Added

- WitnessJobRegistry — crash-surviving background jobs where the filesystem is the source of truth.
- detach-runner.cjs — recoverable process hosting with the lock-file protocol.
- NTFS ACL sandbox (six-dimension closure, guard handle, fail-closed EXIT:-998, tamper detection EXIT:-999).
- 12-item acceptance test (34 assertions).
