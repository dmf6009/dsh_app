# DSHA-7 安全自查报告（§33 日志 / §35 安全要求，基线 S-4 一票否决）

> 仓库：`git@github.com:dmf6009/dsh_app.git` · 分支：`feature/dsha-7-p1d-session-hardening`
> 自查人：开发工程师 · 日期：2026-08-28
> 口径：逐项核对 §33/§35，任一密钥泄漏即为一票否决（S-4）。

## 结论：PASS —— 无泄漏，无否决项

| # | §33/§35 要求 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | API Key 不写日志 | ✅ PASS | 见下「1」 |
| 2 | Credentials 文件权限校验 | ✅ PASS | 见下「2」 |
| 3 | Workspace 边界 / 越界授权 | ✅ PASS | 见下「3」 |
| 4 | 危险命令审批 | ✅ PASS | 见下「4」 |
| 5 | 禁止默认 sudo | ✅ PASS | 见下「5」 |
| 6 | 防止 Shell 命令注入 | ✅ PASS | 见下「6」 |
| 7 | Symlink 越界检查 | ✅ PASS | 见下「7」 |

---

## 1. API Key 不入日志（§33）

- **唯一脱敏收口点**：`src/main/runtime/runtime-log.ts` 的 `RuntimeLogStore.append()` 是所有运行时对话记录（stdout/stderr/event/tool/model）的唯一入口，内部先 `redactSecrets(text, secretSource())`（显式密钥）再叠加 `SECRET_PATTERNS`（`sk-…`、`Bearer …`、`api_key=…`、`Authorization:`、`AKIA…`）。无任何旁路可绕过。
- **stderr 面板**：`dsh:get-stderr-tail`（`src/main/index.ts`）在返回 UI 前再过 `redactSecrets(stderrTail, settings.allSecrets())`。
- **settings 日志**：`SettingsStore` 的 `log`/`warn` 输出在 `src/main/index.ts` 中包裹 `redactSecrets(line, secretSource.current())`；`secretSource.current = () => settings.allSecrets()`。
- **settings.yaml 防御**：`loadSettingsFile` 检测 `api[_-]?key` 残留并告警；密钥只写入 `~/.dsh/.credentials.yaml`。
- **Key 不回显渲染层**：`SettingsStore.view()` 只返回 `apiKeyConfigured` 布尔 + 非可逆 `maskKey`，绝无明文。
- **新增 Session 存储**：`SessionRecord` schema 无 `apiKey`/`credentials` 字段（§15 持久化字段仅 messages/tool calls/file changes/agent state/model/token usage/creation time）；session 目录与文件不承载密钥。
- **测试证据**：`tests/key-log-safety.test.ts`（4 例，覆盖 save/delete/permissions/dshPath/corrupt-load 的日志扫描 + view/warnings/errors 扫描 + stderr 脱敏）；`tests/runtime-log.test.ts`（10 例）。`tests/session-store.test.ts` 新增断言「session 文件无 apiKey/credentials 字段」。

## 2. Credentials 文件权限校验（§35）

- `SettingsStore.enforceCredentialPermissions()` 在 load 时 `stat` → 非 0600 则 `chmod 0600` 并告警；persist 时 `writeYamlAtomic(..., 0o600)`，且 tmp 文件 **从首字节起** 以 0600 创建（关闭“先写后修”的可读窗口），随后 `chmod` 兜底修正 umask。
- `~/.dsh` 目录以 `mode: 0o700` 创建（`writeYamlAtomic` 内 `mkdirSync(..., { recursive: true, mode: 0o700 })`）。
- **新增 Session 目录**：`src/main/session/session-store.ts` 所有 `mkdirSync` 均为 `mode: 0o700`。
- **测试证据**：`tests/settings-store.test.ts`（权限校验与损坏容错）；`tests/session-store.test.ts` 新增「session 目录 0700」断言。

## 3. Workspace 边界与越界授权（§7.3/§35）

- `src/main/workspace/boundary.ts` 提供唯一权威：词法归一 → 包含判定 → **realpath 解析**（含 symlink） → 显式授权接口。realpath 可解析时以 **真实根** 双向裁定；授权键精确、大小写保留。
- 越界操作经边界服务判定 → approval engine 强制 `ask`（携带 `needsAuthorization` 原因）；不可验证路径 → `deny`。
- **测试证据**：`tests/workspace-boundary.test.ts`（lexical `../`、绝对路径越界、real-fs symlink 越界、显式授权、case-twin 不扩散）。

## 4. 危险命令审批（§13/§35）

- `src/shared/approval-rules.ts` 的 `DESTRUCTIVE_PATTERNS`：`rm -r/-rf`、`git push/reset/clean`、`npm/yarn/pnpm publish`、`curl|sh`、`dd if=`、`mkfs`、`shutdown/reboot/poweroff` → 一律 **L2**，三模式矩阵下全部 `ask`（即使 Full Auto 也需确认）。
- 完整规则矩阵 `evaluateApproval`：模式 × L0/L1/L2；本地分级只可**升级**不可降级运行时标注。
- Approval 模态：完整命令等宽不截断、风险徽标、关闭弹窗＝Reject（安全默认）。
- **测试证据**：`tests/approval-engine.test.ts`、`tests/approval-service.test.ts`、`tests/cancel-e2e.test.ts`。

## 5. 禁止默认 sudo（§35）

- `\bsudo\b` 命中 `DESTRUCTIVE_PATTERNS` → 一律 L2 → 必须审批。**无任何自动放行 sudo 的路径**。
- 默认权限模式为 `ask`（`DEFAULT_PERMISSIONS_MODE`），不存在“默认放行”。
- **测试证据**：`tests/approval-engine.test.ts` 覆盖 sudo→L2。

## 6. 防止 Shell 命令注入（§35）

- Desktop 侧**不执行任意 shell**：危险操作经 approval 流转交 DSH runtime 执行，Desktop 侧仅展示与审批。
- 唯一的本地子进程执行点 `git-readonly.ts`：`execFile('git', argv, …)` **无 shell**、仅 argv 数组、`assertReadonlyArgs` 白名单（`rev-parse/status/diff/ls-files/show/symbolic-ref`），非只读子命令直接抛错拒绝 spawn。
- DshProcessManager spawn 子进程同样走 `spawn(command, args)` argv 数组，不经 shell。
- **测试证据**：`tests/git-readonly.test.ts`、`tests/process-manager.test.ts`、`tests/changes-boundary.test.ts`。

## 7. Symlink 越界检查（§35）

- `WorkspaceBoundary` 对目标及其最近存在祖先做 realpath 解析；realpath 可解析时以真实根裁定内外，词法比较仅用于分类失败原因（`lexical` vs `symlink`）。授权键基于用户授权的精确路径，不做折叠。
- **测试证据**：`tests/workspace-boundary.test.ts` 真实 fs symlink 越界用例。

## 继承备忘：沙箱启动参数复验（QA-D）

- 默认启动路径 `src/main/index.ts` 的 `BrowserWindow` 使用 `webPreferences.sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`（生产默认带 sandbox）。
- `--no-sandbox` **仅**出现在显式测试/度量包装器：`scripts/measure-cold-start.mjs`、`scripts/measure-responsive.mjs`、`scripts/smoke-electron.mjs`、`scripts/capture/launcher.mjs`（VM 无 SUID 助手环境），符合 QA-D 约束。
- ⚠ 收口提醒：真实目标环境（带 SUID 助手的桌面）需 QA 复测默认 sandbox 启动路径正常；`--no-sandbox` 不得进入生产启动参数。

## 一票否决核对

逐项扫描后：**无 API Key / 完整 Credential 泄漏到日志、stderr 面板、渲染层、session 文件或任何 UI 可见字符串**。无任何路径可绕过 runtime-log 脱敏收口点。**不触发 S-4 否决。**
