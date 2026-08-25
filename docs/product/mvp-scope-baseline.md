# DSH Desktop MVP 范围基线与验收标准

**关联 Issue：** DSHA-2（启动 dsh_app：完成 MVP 需求拆解、设计、开发与验收）
**输入基准：** 《基于 DeepSeek Harness 的桌面 Coding Agent 需求文档》v0.1（DSHA-2 附件，唯一输入基准）
**作者：** 产品经理
**版本：** v1.0（MVP 前置范围基线，供开发总监全面拆解技术任务）
**关联文档：** UI 验收基线 `docs/design/mvp-pages-ui-ux-spec.md`（feature/dsha-2-mvp-ui-spec@cd4d043）；Phase 0 执行子 Issue DSHA-3。
**范围纪律：** 不超出需求文档范围；所有条目标注出处（§n）。本文与 UI 设计规范冲突时，以本文的范围裁定为准，UI 呈现细节仍按设计规范执行。

---

## 1. MVP 功能清单（Phase 1 必做）

| # | 模块 | 功能点 | 出处 |
| --- | --- | --- | --- |
| F1 | 启动与 Runtime 管理 | DSH 检测 → 启动 desktop profile 子进程（`--stdio`）→ Runtime Ready 状态展示；未安装提供 Install / Choose DSH Path；启动失败展示 stderr 并可重试；Agent Crash 后 Session 保留并提供 Restart Runtime / Resume Session | §19、§32、§38 |
| F2 | Workspace / Project | Open Project 选择本地目录创建 Workspace；Recent Projects 列表支持打开 / Pin / 移除记录；Workspace 边界默认隔离，越界访问必须用户明确授权 | §7、§35 |
| F3 | Git 只读信息 | 当前 Branch 名、Changed Files 清单、git diff 数据源（仅展示；任何写操作不做） | §23 |
| F4 | Chat | 发送任务并接收 Streaming 输出；会话级模型选择器；消息流渲染七种形态（Agent Text / Plan / Tool Call / Shell / File Read / File Edit / Sub-Agent 占位卡） | §8、§9、§18 |
| F5 | Agent 能力 | 经 DSH Runtime 完成搜索、读取、编辑、Shell 四类操作（Desktop 只做事件展示，不做推理/调度/Prompt 组装） | §31、§39 |
| F6 | Tool Call 展示 | tool_started / tool_output / tool_completed 实时渲染；风险等级 L0/L1/L2 标识；Shell 卡片内嵌 Terminal Output Viewer（仅输出查看） | §13、§14、§21 |
| F7 | Diff | Unified Diff 查看（唯一视图）、Changed Files 切换、Prev / Next change 定位、Revert file（执行前二次确认）；hunk 级 Accept/Reject 移 P1 | §11 + 边界裁定① |
| F8 | Approval | Ask / Auto Edit / Full Auto 三种权限模式；L0 免确认、L1 按模式、L2 默认必须确认；弹窗动作 Allow / Allow Once / Reject | §12、§13 |
| F9 | Stop | 运行中一键 Stop，真正取消 LLM Request / Tool Call / Sub-Agent，而非仅停止 UI 流式渲染 | §22 |
| F10 | Session | 每个 Workspace 多 Session；保存 §15 字段清单（User Messages、Agent Messages、Tool Calls、File Changes、Agent State、Model、Token Usage、Creation Time）；应用重启后历史 Session 存在并可恢复上下文；被中断任务的恢复属 P1 | §15、§16 |
| F11 | Model Provider | Provider 配置管理（Provider 名称 / API Type / Base URL / API Key 掩码 / 模型列表），API Type 至少支持 OpenAI Compatible；写入 `~/.dsh/settings.yaml` 与 credentials 文件；已存 Key 任何界面不明文回显 | §17、§18、§35 |
| F12 | 页面骨架 | Home / Workspace（三栏）/ Diff / Settings 四核心页面及其全部状态矩阵 | §37 |

---

## 2. 明确不做清单（MVP，逐条对齐 §36）

§36 原文 11 项全部不做，阶段归属按 §40 开发阶段规划标注：

| 不做项 | 归属 | 备注 |
| --- | --- | --- |
| 完整代码编辑器 | 长期不做 IDE 定位 | §6「暂不追求完整 IDE」；Diff 页只读渲染 |
| SSH Remote Development | 未排期 | §36 |
| Cloud Workspace | 未排期 | §36 |
| Team Collaboration | 未排期 | §36 |
| GitHub PR | Phase 2+ | §23 P2 |
| Multi-Agent | Phase 3 | §26/§40；Sub-Agent 仅保留消息占位卡 |
| Docker Sandbox | Phase 1 之后 | §28 P1 方向；MVP 仅 Workspace Boundary＋Command Approval |
| MCP 管理 UI | Phase 2 承接 | 文档内标注差异裁定：§25 标 P1、§40 归 Phase 2，以 §40 为准 |
| Plugin Marketplace | 未排期 | §36 |
| Voice | 未排期 | §36 |
| Mobile | 未排期 | §36 |

补充三条文档内部口径的统一裁定：

1. **可交互 Terminal**：§14 标 P1、§40 归 Phase 2——取保守交集，MVP 仅做 Terminal Output Viewer，可交互终端归 Phase 2。
2. **Skills 发现与加载**（§24）：文档无阶段标注且不在 §40 Phase 1 清单中——归 Phase 2，MVP 不实现。
3. **Git 写操作**（Commit / Generate Commit Message / Create Branch / Checkout Branch）：§23 明文 P1，MVP 一律不做。

---

## 3. MVP 验收标准（逐条覆盖 §39 全部条目）

QA 按本表逐条测试并在 Issue 记录证据。每条给出前置条件、步骤、通过判定；判定只分 pass / fail。

### 3.1 §39 主验收表

| 编号 | §39 条目 | 前置条件 | 步骤 | 通过判定 |
| --- | --- | --- | --- | --- |
| AC-01 | Workspace·打开本地项目 | 应用启动、Runtime Ready | Home 点 Open Project，选择一个本地目录 | 创建 Workspace 并进入三栏界面；顶栏显示所选目录真实路径；项目出现在 Recent Projects |
| AC-02 | Chat·发送任务 | 已进入 Workspace 并新建 Session | 输入一条编码任务并发送 | 用户消息上屏；Agent 开始响应且运行态标识出现 |
| AC-03 | Chat·Streaming 输出 | AC-02 触发后 | 观察 Agent 回复过程 | 文本随 message_delta 增量追加、无整段重绘闪烁；结束后 message_completed 收敛、光标消失 |
| AC-04 | Agent·搜索 | 任务包含需要检索代码的场景 | 发送如「找到登录校验逻辑」类任务 | 消息流出现 search/grep 类 Tool Call 卡片，含调用参数摘要与结果输出 |
| AC-05 | Agent·读取 | 同上场景继续 | 观察同一 Run 内续步 | 出现 File Read 条目，路径为项目内真实文件 |
| AC-06 | Agent·编辑 | 任务要求修改代码 | 让 Agent 修改一个函数并等待完成 | Changes 栏新增 M/A/D Change Record，路径与实际改动一致 |
| AC-07 | Agent·Shell | 项目含可运行测试 | 要求运行 pytest/npm test | Shell 卡片显示命令全文与 Terminal Output Viewer 输出（如 passed 数） |
| AC-08 | Tool·实时展示 Tool Call | 任一运行中的 Run | 观察 tool_started→tool_output→tool_completed 全程 | 卡片状态进行中→终态实时切换；事件顺序与发生顺序一致；无丢失的工具调用 |
| AC-09 | Diff·查看所有 Agent 修改 | 存在 ≥2 个变更文件的已完成 Run | 打开 Changes 点击各文件进入 Diff；用 Prev/Next 遍历 | Unified Diff 正确渲染增删行；Changed Files 与 Change Record 一一对应；Prev/Next 可在变更块间循环定位 |
| AC-10 | Approval·危险操作 Allow/Reject | 权限模式为 Ask 或触发 L2 命令 | 让 Agent 执行 L2 危险命令（如 rm 目录）分别选 Allow Once 与 Reject | 弹窗模态阻断并完整显示命令与风险等级；Allow 后执行继续；Reject 后该操作不执行且 run 状态明确 |
| AC-11 | Stop·真正中止 Agent | Run 进行中（LLM 输出或长命令执行时） | 点击 Stop | 收到 run_cancelled；此后不再出现该 Run 的新事件；界面解除运行锁定；已产生的 Changes 保留 |
| AC-12 | Session·历史 Session 存在 | 至少完成一次含消息与变更的 Session | 完全关闭应用后重新打开，进入同一 Workspace | Session 列表仍列出历史 Session；打开后消息、Tool Call、Changes、所用模型均可回看（§15 字段） |
| AC-13 | Provider·OpenAI Compatible | Settings Models 中配置一个 OpenAI Compatible Provider（Base URL＋API Key） | 保存后新建 Session，从模型选择器选用其模型并发送任务 | 配置保存成功且 Key 仅掩码显示；模型出现在选择器；任务经该模型正常完成一轮对话 |

### 3.2 补充验收（非 §39 强制项，源自其他章节，建议 QA 一并执行）

| 编号 | 来源 | 内容 |
| --- | --- | --- |
| S-1 | §12/§13 | 三种权限模式行为差异可复现：Ask 对危险操作全部询问；Auto Edit 放行读取/普通编辑/普通 Shell 但 L2 仍询问；Full Auto 仅 L2 强制确认 |
| S-2 | §32 | 四类错误场景各有专属文案与出路：DSH 未安装（Install/Choose DSH Path）、Runtime 启动失败（stderr＋重试）、Model API 401/404/429（内联错误卡）、Agent Crash（Session 不丢＋Restart/Resume） |
| S-3 | §34 | 冷启动 <3 秒渲染首屏；Runtime 就绪 <2 秒；大项目启动不触发全库扫描 |
| S-4 | §33/§35 | API Key 与完整 Credential 不出现在任何日志/界面明文中；credentials 文件权限有校验；越出 Workspace 的访问必须弹窗明确授权；无默认 sudo |
| S-5 | 裁定① | Revert file：点击后二次确认；确认后文件恢复至改动前内容，Changes 列表同步移除该记录 |
| S-6 | UI 设计规范 | 按 `docs/design/mvp-pages-ui-ux-spec.md` V1–V16 视觉验收清单走查 |

---

## 4. Phase 0 Runtime Prototype 成功判据（§40）

范围锁定：只验证 **Electron ↔ JSONL ↔ DSH** 链路，只实现 **message / stream / tool / done** 四能力（§40 原文）；与 DSHA-3 派发口径一致（协议层另覆盖 cancel/error 等事件定义，但验收以下列判据为准）。

| 编号 | 判据 | 通过标准 |
| --- | --- | --- |
| P0-1 | 进程链路建立 | Electron 主进程成功 spawn `dsh --profile desktop --stdio` 子进程，JSONL 双向通信就绪（§19/§20） |
| P0-2 | message 下行 | Desktop 按帧格式 `{v,type:"run",session_id,workspace,message}` 发送任务并被受理（§20） |
| P0-3 | stream 上行 | message_delta 增量渲染到最小聊天窗口，message_completed 后文本定稿 |
| P0-4 | tool 展示 | 一次 tool_started / tool_output / tool_completed 在窗口可见（最小卡片段即可，不要求样式完整） |
| P0-5 | done 终止 | done 事件到达后本次 Run 结束、UI 复位可再次发送 |
| P0-6 | 稳定性 | 连续 10 次 run 无崩溃、无进程残留；每次 run 恰好收到一个终止事件（done 或 error），事件不丢不错序 |
| P0-7 | 干净退出 | 关闭应用后子进程被回收，无 orphan dsh 进程 |

**通过定义：P0-1～P0-7 全部满足即 Phase 0 通过，进入 Phase 1 全面开发。**
明确不在 Phase 0 范围：Approval 弹窗、Diff Viewer、Session 持久化、Settings/Provider 管理、三栏完整布局（与 DSHA-3「明确不做」一致；DSHA-3 不受第 5 节边界裁定影响）。

---

## 5. 对开发侧三项边界裁定的最终确认（PM 裁定）

1. **Diff 操作集：确认。** Phase 1 必做＝Unified 查看＋文件切换＋Prev/Next＋Revert file；逐 hunk Accept/Reject 移 P1。认同理由：§39 Diff 条目仅需「查看所有 Agent 修改」，Revert file 以低成本兜底 §38「用户确认后结束」。补充约束一处：Revert file 属丢弃性操作，执行前须二次确认（纳入 S-5 验收），符合 §12/§35 危险操作知情原则。
2. **Agent Mode 选择器：确认。** MVP 固定 Agent 档、不渲染模式选择器，顶栏位置留给模型选择器（§18）。Plan/Review 按 §40 于 Phase 2 在同位置扩展；Ask 档不单独实现——§38 MVP 用户流程全程为 Agent 执行流，独立 Ask 档价值低且 §40 未将其列入任何阶段，避免范围蔓延。
3. **Sub-Agent 卡片：确认。** 仅渲染消息占位卡（§9 形态预留），Multi-Agent 能力本身为 §36 不做项、§40 Phase 3 方向。

以上三项为最终基线；后续若推翻需在本 Issue 留言说明并同步更新本文版本号。

---

## 6. 给开发总监拆解的衔接提示

- **协议依赖**：AC-08/10/11 依赖 Runtime Protocol 实现 §21 的事件全集（尤其 approval_required / approval_response / run_cancelled）；DSHA-3 已按此口径定义 TS 类型，Phase 1 直接复用。
- **存储依赖**：AC-12 的字段核对以 §15 清单为准（含 Token Usage、Model、Agent State）。
- **安全底线**：S-4 为一票否决项，任一泄漏即 fail。
- **验收合并**：QA 执行时将本文 §3 表与 UI 设计规范 V1–V16 合并为最终验收清单。
