# DSHA-5 P1-B 独立 QA 门禁证据（QA工程师）

## 被测对象

- 分支：`feature/dsha-5-p1b-runtime-chat-approval`
- Commit：`e0119b9a35a42aa1bf0253e84d21ed5132c02397`（经 `git ls-remote` 确认为该分支远端 tip）
- 工作树：干净（仅新增本 QA 目录与 `tests/qa-gate-e0119b9.test.ts`）

## 环境

- 无桌面 Linux VM（Ubuntu），`DISPLAY` 默认为空；`xvfb-run` 与 `Xvfb` 位于 `/usr/bin`
- node v22.23.2 / npm 10.9.8；Electron 33 二进制随依赖下载完整
- 容器限制：SUID sandbox helper 无法配置（`no-new-privileges` 阻止提权，
  `kernel.unprivileged_userns_clone=1` 但 chrome-sandbox 需 root:4755）

## 执行记录（命令 → 退出码）

| # | 检查 | 命令 | 退出码 | 结果 |
| - | ---- | ---- | ------ | ---- |
| 1 | 安装依赖 | `npm ci` | 0 | 270 packages |
| 2 | 类型检查 | `npm run typecheck` | 0 | main/renderer/tests 三套 tsconfig 通过 |
| 3 | Lint | `npm run lint` | 0 | 0 错误 |
| 4 | 构建 | `npm run build` | 0 | main + renderer |
| 5 | 全量单测 | `npm test` | 0 | **17 文件 / 242 用例通过** |
| 6 | 全量单测（含 QA 回归） | `npm test`（18 文件） | 0 | **18 文件 / 246 用例通过** |
| 7 | 针对性复跑 | `npx vitest run tests/runtime-client.integration.test.ts tests/approval-service.test.ts --reporter=verbose` | 0 | **2 文件 / 31 用例通过** |
| 8 | 矩阵/边界/取消 | `npx vitest run tests/approval-engine.test.ts tests/workspace-boundary.test.ts tests/cancel-e2e.test.ts` | 0 | **3 文件 / 92 用例通过** |
| 9 | QA 独立回归 | `npx vitest run tests/qa-gate-e0119b9.test.ts --reporter=verbose` | 0 | **1 文件 / 4 用例通过** |
| 10 | Electron 冒烟（Xvfb 规范命令） | `xvfb-run -a --server-args="-screen 0 1920x1080x24" npm run smoke:app` | 0 | `[app-smoke] PASS — Electron ↔ stub runtime closed loop verified` |
| 11 | 协议冒烟 | `npm run smoke:protocol` | 0 | PASS |
| 12 | DSH 桌面冒烟 | `npm run smoke:dsh` | 0 | SKIP（desktop profile 未装，环境预期） |

### --no-sandbox 披露（第 10 项）

先尝试不加 `--no-sandbox` 运行：
`xvfb-run -a --server-args="-screen 0 1920x1080x24" env DSH_ELECTRON_ARGS=" " node scripts/smoke-electron.mjs`
→ **退出码 1**：Chromium SUID helper 存在但非 root:4755，Electron 自行中止
（`FATAL:setuid_sandbox_host.cc ... not configured correctly`）。容器无 sudo 提权路径。
随后按仓库 smoke 脚本的容器默认值运行（脚本在 Linux 自动附加
`--no-sandbox --disable-dev-shm-usage`）：**退出码 0，PASS**。

风险评估：`--no-sandbox` 仅关闭 Chromium 进程级沙箱层；渲染进程仍保留 main
进程设置的 `contextIsolation` / `sandbox` webPreferences（脚本注释明确说明），
且本次被测面为主进程 Runtime/Approval 逻辑而非渲染层安全边界。属测试环境约束，
非产品缺陷；真实桌面环境的原生集成验证仍需按验证边界另行补测。

## QA 重点回归结论（独立复验）

1. restart ready 前 exit：`crashed` + `lastCrash.code === 7` + 启动诊断保留；
   连续第三次 restart 仍可发起，状态序列含三次 `starting` 且无 `stopped`。✅
2. restart-from-ready：直接回到 `ready`，connection-state 序列不含 `crashed`。✅
3. 自动 allow / deny / 缓存命中三类投递失败：均升级为真实 pending +
   `respond_failed` notice 同帧可见；不伪造 resolved、不写授权；恢复后人工应答
   恰好产生一次 resolved(viaModal=true)。✅（auto-allow 路径由 QA 新增回归覆盖）
4. timeout × runtime 持续不可达：升级 pending 超时安全拒绝并丢弃条目，
   pendingCount 归零、零伪造 resolved、无授权残留。✅
5. Stop 真取消与 Workspace 边界授权矩阵：cancel-e2e、常驻取消、审批矩阵
   （3×3×动作类别覆盖性检查）、workspace-boundary 共 92 用例全绿。✅

## 孤儿进程检查

测试全部结束后：`ps -eo pid,ppid,comm | grep -Ei "electron|Xvfb"` → 无匹配
（pgrep 的唯一命中为检查命令自身）。无 Electron / Chromium / Xvfb 孤儿进程。✅

## 本分支新增内容

- `tests/qa-gate-e0119b9.test.ts` — QA 独立回归用例（不属于开发套件，见文件头注释）
- `qa-evidence/README.md` — 本证据记录
