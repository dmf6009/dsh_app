# DSHA-7 QA 支持：构建步骤、测试环境与合并验收清单

> 仓库：`git@github.com:dmf6009/dsh_app.git` · 分支：`feature/dsha-7-p1d-session-hardening`
> 供 QA 执行 AC-01～13 ＋ S-1～6 ＋ UI V1–V16 合并验收清单（基线：`docs/product/mvp-scope-baseline.md` @80be59c + `docs/design/mvp-pages-ui-ux-spec.md` @cd4d043）

## 1. 打包与构建步骤

```bash
# 1) 安装依赖
npm ci

# 2) 类型检查（main + renderer + tests 三套 tsconfig）
npm run typecheck

# 3) Lint
npm run lint

# 4) 构建（编译 main TS → dist/main，Vite 打包 renderer → dist/renderer）
npm run build
#   构建产物：dist/main/index.js（主进程入口）、dist/renderer/index.html + assets/*
#   package.json "main": "dist/main/index.js" → electron . 直接加载

# 5) 单元/集成测试（vitest）
npm test

# 6) 专项探针（可选，需 Electron 二进制 + 显示）
npm run smoke:protocol   # 纯 Node，无需 Electron — 协议闭环
npm run test:cold-start  # §34 冷启动 / Runtime 就绪 测量
npm run test:responsive  # 响应式布局回归
```

打包为分发包（Phase 1 之外，QA 如需可后续补 `electron-builder` 配置；当前以 `npm run build` + `electron .` 运行验证为准）。

## 2. 测试环境说明

- **运行时**：Node.js（@types/node ^22）、Electron ^33.2.1、Vite 5、vitest 2.1。`npm ci` 一次性安装。
- **默认子进程**：无 `DSH_RUNTIME_BIN` 时，主进程 spawn 参考.stub `scripts/stub-runtime.mjs`（Phase 0 默认），可验证完整协议闭环而无需真实 `dsh`。
  - 接入真实 dsh：设 `DSH_RUNTIME_BIN=dsh`（或绝对路径）与 `DSH_RUNTIME_ARGS=--profile desktop --stdio`。
- **无头环境**：VM 无 SUID 助手时，测试/探针脚本以 `--no-sandbox` 启动 Electron（仅限显式测试包装器，QA-D 复验已记录；生产默认 `sandbox: true`）。
- **已知 flaky（环境性，非回归）**：`tests/xvfb-display.integration.test.ts` 中 “a run that owns its socket may clean it” 用例在本 VM 无头环境偶发失败，且在干净 `main@36413bf` 上同样失败——属环境性 flaky，非本 Issue 回归。QA 如复现可在有显示的真实桌面复测。
- **真实 dsh CLI 未安装**：`scripts/smoke-dsh-desktop.mjs` 以 SKIP（exit 1，非崩溃）告示「desktop profile not installed」；协议层验证改由 `scripts/smoke-protocol.mjs`（stub）覆盖。

## 3. AC-01～13 全表本地预演（开发工程师自测）

> 口径：能以协议/单元/集成测试覆盖的条目给出证据代码路径与测试；需真实 dsh/Provider 的条目标注「待 QA 真环境复测」。本预演不替代 QA 验收，仅作开发自证。

| 编号 | 条目 | 预演结论 | 证据 |
| --- | --- | --- | --- |
| AC-01 | 打开本地项目→三栏 | ✅ PASS（代码路径） | `WorkspaceManager.openViaDialog/openAt`（`src/main/workspace/index.ts`）、Recent Projects 持久化、`WorkspacePage` 三栏布局；`tests/recent-projects.test.ts` |
| AC-02 | 发送任务→运行态 | ✅ PASS | `smoke-protocol.mjs` 收 `run_started`；`chat/model.ts reduceChat send→running`；`tests/chat-model.test.ts` |
| AC-03 | Streaming 输出 | ✅ PASS | `smoke-protocol.mjs` 收 7×`message_delta`→`message_completed`；`tests/chat-model.test.ts` 流式追加/收敛/光标 |
| AC-04 | Agent 搜索 | ✅ PASS（协议） | `smoke-protocol.mjs` 收 `tool_started(search/grep)`；分类 `READ_TOOLS`；`tests/approval-engine.test.ts` |
| AC-05 | Agent 读取 | ✅ PASS | `smoke-protocol.mjs` 收 `file_read`；`chat/model.ts reduceEvent file_read` |
| AC-06 | Agent 编辑→Changes | ✅ PASS | `smoke-protocol.mjs` 收 2×`file_changed`；`ChangeRecordService` 聚合；`tests/change-record-service.test.ts`、`tests/changes-store.test.ts` |
| AC-07 | Agent·Shell + Terminal Viewer | ✅ PASS | `smoke-protocol.mjs` 收 `tool_started/tool_output/tool_completed`（shell）；`TerminalViewer` 渲染；`tests/chat-model.test.ts` |
| AC-08 | Tool 实时展示 + 顺序/去重 | ✅ PASS | `RuntimeEventBus` 有序去重（`tests/event-bus.test.ts`）；畸形帧隔离；`tests/runtime-client.integration.test.ts` |
| AC-09 | Diff 查看/Prev-Next/Changed | ✅ PASS | `DiffPage` Unified + hunk 导航；`tests/diff-view.test.ts`、`tests/file-diff.test.ts`、`tests/change-record-service.test.ts` |
| AC-10 | Approval Allow/Reject | ✅ PASS | 矩阵 + 弹窗；`tests/approval-engine.test.ts`、`tests/approval-service.test.ts`、`tests/cancel-e2e.test.ts` |
| AC-11 | Stop 真正中止 | ✅ PASS | `smoke-protocol.mjs` cancel→`run_cancelled`；`tests/cancel-e2e.test.ts`（解锁） |
| AC-12 | 历史 Session 重开可回看 | ✅ PASS | **新增**：`SessionStore` + `tests/session-store.test.ts`（跨实例重启往返、§15 字段、损坏恢复）；`chat/model.ts toSessionItems/fromSessionItems` + `tests/chat-session-projection.test.ts`（往返无损） |
| AC-13 | Provider OpenAI Compatible | ✅ PASS（配置层） | `SettingsStore` 读写 `~/.dsh/settings.yaml` + credentials 0600；`tests/settings-store.test.ts`、`tests/model-refresh.test.ts`。**待 QA 真实 Provider 复测任务一轮** |

## 4. S-1～6 自测

| 编号 | 自测结论 | 证据 |
| --- | --- | --- |
| S-1 三模式行为差异 | ✅ PASS | `tests/approval-engine.test.ts` 矩阵全组合 |
| S-2 §32 四错误场景文案与出路 | ✅ PASS | **新增** `src/shared/error-copy.ts` 三段式 + `tests/error-copy.test.ts`；Home 启动横幅 / Workspace crash+startup 横幅 / 消息流内联错误卡（`chat/model.ts describeError`） |
| S-3 性能 | ✅ PASS | `scripts/measure-cold-start.mjs`：首屏 648ms（<3s）、Runtime 就绪 783ms（<2s）；无启动全库扫描（见 `docs/performance/dsha-7-cold-start-report.md`） |
| S-4 安全一票否决 | ✅ PASS 无泄漏 | `docs/security/dsha-7-self-audit.md`；`tests/key-log-safety.test.ts`、`tests/runtime-log.test.ts`、`tests/workspace-boundary.test.ts`、`tests/session-store.test.ts`（新增） |
| S-5 Revert 二次确认 | ✅ PASS | `DiffPage` ConfirmDialog 二次确认 + 幂等；`tests/change-record-service.test.ts`、`tests/diff-view.test.ts` |
| S-6 UI V1–V16 | ⚠ 待 UI/UE 走查 | 视觉验收清单 `docs/design/mvp-pages-ui-ux-spec.md`；本 Issue 新增 sessions-head/switch/delete、recovery 三段式、banner-action 样式，建议 UI/UE 顺带复核 |

## 5. 交给 QA 的入口

- 分支：`feature/dsha-7-p1d-session-hardening`，基于 `main@36413bf`（P1-C 合并后）。
- 构建：`npm ci && npm run build && electron .`（或 `DSH_RUNTIME_BIN=dsh DSH_RUNTIME_ARGS=--profile desktop --stdio` 接真实 dsh）。
- 验收清单：本文 §3（AC）+ §4（S）+ `docs/design/mvp-pages-ui-ux-spec.md` V1–V16。
- 预演结论：AC-01～12 PASS（协议/代码层），AC-13 配置层 PASS 待真环境；S-1/2/3/4/5 PASS，S-6 待 UI/UE。
