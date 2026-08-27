# DSHA-7 冷启动 / Runtime 就绪性能报告（§34 / P0 同口径）

> 仓库：`git@github.com:dmf6009/dsh_app.git` · 分支：`feature/dsha-7-p1d-session-hardening`
> 测量脚本：`scripts/measure-cold-start.mjs` · 日期：2026-08-28
> 运行时：参考 stub runtime（`scripts/stub-runtime.mjs`，`STUB_DELTA_DELAY_MS=5`），Electron 33，VM 无头环境经 Xvfb 显示

## §34 目标与实测

| 指标 | §34 目标 | 实测（3 次取值） | 结论 |
| --- | --- | --- | --- |
| 冷启动首屏 | < 3000 ms | 641 / 635 / 661 ms | ✅ PASS |
| Runtime 就绪（状态转绿） | < 2000 ms | 769 / 775 / 801 ms | ✅ PASS |

测量口径：
- **首屏**：Electron 子进程 spawn → renderer 首帧 `did-finish-load`（`[first-paint]` 主进程日志，在 `loadFile` 之前注册一次）。
- **Runtime 就绪**：spawn → DSH 子进程发出 `ready` 帧、主进程连接状态切到 `ready`（`[runtime] ready` 日志）。

> 与 P0 同口径：首屏以“渲染进程完成首次导航加载”为锚，Runtime 就绪以 `ready` 帧落定为锚，均不依赖任何模型调用。

## 启动路径禁止全量扫描项目内容（§34）—— 静态核查

§34 要求“大项目不允许启动时扫描整个项目全部内容；文件搜索应依赖 rg / git / DSH 工具”。核查结果：

1. **启动链路无项目树遍历**：`grep -rn 'readdir|readdirSync|glob|walk' src/main/` 仅命中
   - `session-store.ts` 的 `rebuildIndex`：仅扫描 **本工作区的 sessions 目录**（`~/.dsh/desktop/sessions/<workspaceId>/`，文件级，非项目内容），且仅在 `index.json` 损坏时触发；
   - 各 `mkdirSync(..., { recursive: true })`（建目录，非遍历）；
   - `boundary.ts` 的 realpath 向上回溯（只走到最近存在祖先，不递归枚举）。
   **无任何对 `workspaceRoot` 的递归 `readdir` 调用出现在启动路径上。**
2. **Changes / Git 数据为按需触发**：`ChangeRecordService.reconcile` 仅在
   - runtime 终止帧（`run_completed`/`done`/`run_cancelled`）到达后对账，或
   - UI 显式调用 `getChangesSnapshot` 时
   才执行；启动时不调用。
3. **Git 只读数据源**：`src/main/changes/git-readonly.ts` 仅通过 `execFile('git', …)` 运行只读子命令（`rev-parse` / `status --porcelain=v1 -z` / `diff HEAD -- <path>` / `ls-files` / `show`），并在白名单外拒绝 spawn（见 `assertReadonlySubcommand`）。无 JS 层递归扫描。
4. **文件搜索依赖 rg/git/DSH**：Desktop 不自带项目内容搜索；搜索能力由 DSH 工具（runtime 侧）承担，与本 Issue 收口范围一致。

## 复现命令

```bash
npm run build                       # 构建 main + renderer
node scripts/measure-cold-start.mjs # 输出 JSON：first_paint_ms / runtime_ready_ms / *_pass
```

> 在缺少 Electron 二进制或显示的环境中脚本会以 `SKIP`（exit 0）退出，策略与 `smoke:app` / `test:responsive` 一致。

## 已知限制

- VM 无头环境经 Xvfb、`--no-sandbox` 启动 Electron（VM 无 SUID 助手）。收口阶段沙箱启动参数复验见下方“继承备忘”。
- 实测为 stub runtime；真实 `dsh --profile desktop --stdio` 的 `ready` 延迟取决于其启动实现，验收时需在真实目标环境复测。
- 指标不含模型调用延迟（§34：Chat Streaming 延迟主要取决于 Model Provider）。
