# DSH Desktop MVP 四核心页面 UI/UE 设计规范

**关联 Issue：** DSHA-2（启动 dsh_app：完成 MVP 需求拆解、设计、开发与验收）
**输入基准：** 《基于 DeepSeek Harness 的桌面 Coding Agent 需求文档》v0.1（本 Issue 附件，唯一输入基准）
**作者：** UI-UE设计师
**版本：** v1.0（MVP 前置设计基线）
**范围约束：** 不超出需求文档范围，不新增功能设想；所有设计点均标注文档出处（§n）。

---

## 1. 设计范围

覆盖文档 §37 定义的 MVP 四个核心页面：

| 页面 | 文档定义内容 | 对应章节 |
| --- | --- | --- |
| Home | Recent Projects、Open Project | §7、§37 |
| Workspace | Sessions、Chat、Changes | §8、§9、§10、§37 |
| Diff | Changed Files、Code Diff（仅 Unified） | §11、§37 |
| Settings | Models、DSH、Permissions | §12、§17、§32、§37 |

不在本期范围：§36「MVP 不做的内容」全部条目，以及 §40 归入 Phase 2+ 的能力（Terminal 交互终端、Git Commit/PR、Skills/MCP 管理 UI、Plan/Review 模式等）。涉及文档内阶段归属存在歧义的条目，统一列入 §10 待确认清单，由 PM 范围基线裁定，本规范只做 UI 预留。

---

## 2. 全局导航模型与信息架构

### 2.1 页面关系

```text
                 ┌────────────┐
        启动 ──▶ │    Home    │
                 └─────┬──────┘
                       │ Open Project / 点击最近项目
                       ▼
                 ┌────────────┐   Changes 点击文件 /
                 │ Workspace  │   完成摘要 View Diff
                 │ (三栏, §8) │ ◀──────────┐
                 └─────┬──────┘            ▼
                       │                ┌────────────┐
                       │  返回          │    Diff    │
                       └───────────────▶│ (仅 Unified)│
                                        └────────────┘
      Settings 为全局入口（Home 与 Workspace 顶栏均可进入），
      进入后可返回原页面。
```

- Home 是启动默认页（§38 用户流程起点：启动 → 检测 DSH → 启动 desktop profile → Runtime Ready）。
- Workspace 是核心工作页；Diff 是从 Workspace 进入的独立页面（§37 将其列为独立核心页），提供返回 Workspace 的显式出口。
- Settings 从任意页面顶栏齿轮图标进入（导航细节，非新增功能；内容严格为 §17 Models + §32 DSH + §12 Permissions）。

### 2.2 Runtime Event → UI 呈现映射（§21）

UI 所有动态表现均由 Runtime Protocol 事件驱动（§20/§21），映射如下：

| 事件 | UI 呈现 |
| --- | --- |
| ready / session_created | 顶部 Runtime 状态灯转绿；新 Session 出现在左栏列表 |
| run_started | 中栏出现运行中指示；Stop 按钮激活；输入框禁用（§22） |
| message_delta | Agent 回复流式增量追加，尾部显示流式光标 |
| message_completed | 该条消息定稿，光标消失 |
| plan | 渲染 Plan 卡片（编号列表样式，§9） |
| tool_started | 追加 Tool Call 卡片，状态=进行中（spinner）（§5.4 可观察） |
| tool_output | 对应卡片输出区增量填充；Shell 类卡片内嵌 Terminal Output Viewer（§14 MVP 形态） |
| tool_completed | 卡片状态转为成功/失败终态 |
| file_read | 渲染 Read 条目（路径等宽字体，§9） |
| file_changed | 右栏 Changes 列表实时增补/更新 M/A/D 徽标（§10/§21） |
| approval_required | 弹出 Approval 模态弹窗，阻断后续执行（§12/§21） |
| approval_response | 弹窗关闭，run 按 runtime 决定继续或终止（作用域语义见 §10 待确认项） |
| error | 按错误类型渲染对应错误态（§32 四类场景，见 §7.4） |
| run_completed | 运行中态解除；尾部渲染完成摘要卡「N files changed · View Diff」（§38） |
| run_cancelled | 运行中态解除；消息区标记「已中止」，已产生 Changes 保留展示 |

---

## 3. 页面一：Home

### 3.1 信息结构（§7、§37）

```text
┌──────────────────────────────────────────────────────┐
│ [DSH 状态横幅：就绪 ✓ / 未找到 ✗]            ⚙ Settings│
│                                                      │
│   DSH Desktop                                        │
│   [ Open Project ]  ← 主按钮                         │
│                                                      │
│   Recent Projects                                    │
│   ┌────────────────────────────────────────────┐     │
│   │ 📌 example-service                          │     │
│   │ ~/projects/example-service                  │     │
│   │                    [打开] [Pin] [移除记录]   │     │
│   ├────────────────────────────────────────────┤     │
│   │ android-client                              │     │
│   │ ~/Android                                   │     │
│   └────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────┘
```

- 项目卡片要素：项目名、本地路径（等宽字体）、Pin 状态；操作：打开 / Pin / 移除记录（§7.2 原文三项，不增减）。
- 排序规则：Pin 项置顶，其余按最近打开时间倒序。
- 顶部常驻 DSH 状态横幅：Runtime Ready（绿）/ 未检测到 DSH（红）/ 启动中（黄，spinner）——对应 §38 启动链路与 §32 错误处理。

### 3.2 交互流程

1. **首次启动与 DSH 检测**（§38）：启动应用 → 检测 DSH → 找到则启动 desktop profile → Runtime Ready → 显示 Home；未找到则横幅报错「DeepSeek Harness not found.」，提供 Install / Choose DSH Path 两个动作（§32 原文）。
2. **打开项目**（§7.1）：点击 Open Project → 系统目录选择器 → 选择 `~/projects/example` → 创建 Workspace → 跳转 Workspace（空 Session 态）。
3. **打开最近项目**（§7.2）：点击卡片或「打开」→ 直接进入该 Workspace。
4. **移除记录 / Pin**（§7.2）：仅操作列表记录本身，不删除任何项目文件。

### 3.3 状态矩阵

| 状态 | 触发条件 | UI 表现 |
| --- | --- | --- |
| 空态 | 无最近项目且非首次引导 | 主视觉区仅 Open Project 大按钮 + 一句引导文案，不渲染空列表框 |
| 加载中 | 最近项目列表读取中 | 列表区域骨架屏（2–3 行卡片占位） |
| 正常态 | 有记录且 Runtime Ready | 项目卡片列表 + 可用主按钮 |
| 运行时启动中 | desktop profile 启动中 | 横幅黄色 spinner「正在启动 DSH Runtime…」 |
| 错误：DSH 未找到 | 检测失败 | 红色横幅原文「DeepSeek Harness not found.」+ Install / Choose DSH Path 按钮（§32） |
| 错误：Runtime 启动失败 | 子进程退出/stderr | 错误面板展开显示 stderr 内容（等宽字体）+ 重试按钮（§32） |
| 错误：目录失效 | 最近项目路径已不存在/无权限 | 卡片置灰并标注「目录不可访问」，仅保留「移除记录」，不可打开 |
| disabled | 目录选择被取消 | 无动作发生，停留在 Home（不弹错误） |

---

## 4. 页面二：Workspace（三栏布局，§8）

### 4.1 信息结构

```text
┌──────────────┬──────────────────────────────┬─────────────┐
│ Sessions     │ 顶栏: ‹返回Home·项目路径·模式徽标·模型选择▾·⚙ │
│              ├──────────────────────────────┼─────────────┤
│ [+ New       │ User: 修复登录问题             │ Changes     │
│  Session]    │                               │             │
│              │ Agent: ...(streaming▍)        │ M src/auth/login.py
│ ● 修复登录问题│                               │ M tests/test_login.py
│   GLM 5.2    │ Plan ──────────────           │ A tests/test_session_timeout.py
│   14:32      │ 1. 定位登录接口 ...            │             │
│ ○ 增加Redis..│ Tool: grep -R "login" src/ ✓  │ (M/A/D 徽标) │
│              │ $ pytest tests/test_login.py  │             │
│              │   12 passed                   │             │
│              │ Edited src/auth/login.py      │             │
│              ├──────────────────────────────┴─────────────┤
│              │ [输入框............................] [Stop] [发送] │
└──────────────┴───────────────────────────────────────────┘
```

**左栏 Sessions（§15）**
- 「New Session」按钮 + 会话列表。会话条目显示：会话名（取首条用户消息摘要）、当前模型徽标、创建/最近时间。
- 当前会话高亮；历史会话点击即恢复上下文（§16）。

**中栏 Agent Chat**
- 顶栏：返回 Home、当前项目路径（等宽，明示隔离边界 §7.3）、权限模式徽标（Ask/Auto Edit/Full Auto，§12）、模型选择下拉（§18，如 DeepSeek V4 Flash ▼）、Settings 入口。
- 消息流按 §9 七种形态渲染：Agent Text（Markdown 流式）、Plan（编号卡片）、Tool Call（卡片：工具名+参数摘要+状态图标+输出折叠区）、Shell（命令行 `$` 样式 + Terminal Output Viewer，§14）、File Read、File Edit、Sub-Agent 占位卡（仅消息形态预留，Multi-Agent 功能本身属 P2，§36）。
- 底部输入区：多行输入框 + 发送按钮；运行中原位切换为 Stop 按钮（§22），输入框禁用。

**右栏 Changes（§10）**
- Change Record 列表：`M/A/D + 文件路径`（M 黄、A 绿、D 红徽标）。
- 运行中随 `file_changed` 实时增补；点击任一文件进入 Diff 页（§10「点击文件显示 Diff」）。
- run_completed 后底部固定完成摘要：「N files changed · View Diff」（§38）。

### 4.2 交互流程

1. **发送任务**（§38）：New Session → 顶栏选模型（§18）→ 输入任务 → 发送 → 流式回复与 Tool Call 卡片依事件实时追加 → 结束后摘要卡 View Diff。
2. **Approval 处理**（§12/§13）：`approval_required` → 应用级模态弹窗（详见 §7.5）→ Allow / Allow Once / Reject → 关闭并回传 `approval_response`。
3. **Stop**（§22）：运行中点击 Stop → 发送 cancel → 真正取消 LLM Request / Tool Call / Sub-Agent（不能只停 UI streaming）→ `run_cancelled` 后标记已中止，Changes 区保留已完成变更。
4. **查看 Diff**：右栏点击文件或摘要卡 View Diff → 进入 Diff 页。
5. **Session 恢复**（§16、§39）：关闭应用重新打开 → Home 打开项目 → 历史 Session 仍存在 → 点击恢复 conversation context / workspace / model / task state。

### 4.3 状态矩阵

| 状态 | 触发条件 | UI 表现 |
| --- | --- | --- |
| 空态：无 Session | 新开 Workspace | 左栏仅 New Session 按钮 + 引导语；中栏空态插画「输入任务开始」 |
| 空态：空会话 | Session 已建未发消息 | 中栏居中引导文案，无历史消息 |
| 加载中 | 会话列表/runtime 连接读取中 | 左栏骨架屏；runtime 未就绪时中栏顶部细进度条 |
| Agent 运行中 | `run_started` 至 `run_completed/cancelled` | 流式光标；进行中 Tool 卡片 spinner；Stop 激活、发送与输入禁用；右栏实时更新；顶栏模式/模型选择锁定 |
| Approval 待决 | `approval_required` | 全屏模态弹窗（见 §7.5），其余区域遮罩不可交互 |
| 错误：Model API | 401 / 404 / 429 | 消息流内联错误卡：状态码+原因+建议动作（401→检查 API Key 并跳转 Settings Models 等）（§32） |
| 错误：Runtime 断开 | 子进程崩溃 | 顶栏红色状态灯 + 横幅「Agent Crash」；Session 数据不丢失；提供 Restart Runtime / Resume Session 两动作（§32） |
| 已取消 | `run_cancelled` | 消息流尾部灰色「已被手动停止」标记；输入恢复可用 |
| disabled：未配置 Provider | Provider 列表为空 | 输入框与发送禁用，提示「请先在 Settings → Models 添加 Provider」（§17/§18 前置依赖） |

---

## 5. 页面三：Diff（仅 Unified，§11）

### 5.1 信息结构

```text
┌──────────────┬───────────────────────────────────────────┐
│ ‹ 返回       │  src/auth/login.py            [M]         │
│   Workspace  │ ───────────────────────────────────────── │
│              │ @@ -12,7 +12,8 @@                          │
│ Changed Files│            if session:                    │←红底删除行
│              │ +          if session and session.is_valid():│←绿底新增行
│ M login.py   │                                            │
│ M test_lo…py │ @@ -34,2 +35,6 @@                          │
│ A test_se…py │                                            │
│              │ （Unified 单栏，无 Side-by-side 切换）        │
│ 3 files      │ ◀ Prev change    Next change ▶             │
└──────────────┴───────────────────────────────────────────┘
```

- 左侧 Changed Files 列表 = §37「Changed Files」；右侧 Unified Code Diff = §37「Code Diff」。两区即整页全部结构。
- MVP 仅提供 Unified Diff 视图（§11「MVP 至少支持 Unified Diff」+ 本次指令明确 Diff 仅 Unified）；Side-by-side 不出现在 MVP UI。
- Previous / Next change 为 §11 明列的阅读导航，MVP 保留为 diff 底部/快捷键定位。
- Accept / Reject / Revert file 在 §11 中列出但未标注阶段归属，MVP 是否纳入以 PM 范围基线为准；本规范仅在文件头预留操作位，不做默认呈现（见 §10 待确认项）。
- 基于 Monaco Editor 渲染（§29 技术栈），只读，不提供编辑能力（完整代码编辑器属 §36 不做项）。

### 5.2 交互流程

1. 自 Workspace Changes 点击文件 / View Diff 进入，默认选中第一个变更文件。
2. 左侧列表切换文件，右侧刷新对应 Unified Diff；文件徽标 M/A/D 随行。
3. Prev / Next change 在 hunk 间跳转，当前 hunk 高亮。
4. 「‹ 返回」回到 Workspace，保持原 Session 与滚动位置。

### 5.3 状态矩阵

| 状态 | 触发条件 | UI 表现 |
| --- | --- | --- |
| 空态 | 当前 Session 无任何 Change Record | 居中文案「暂无文件变更」+ 返回按钮 |
| 加载中 | Diff 计算中 | 右侧代码区骨架屏 |
| 正常态 | 存在变更 | 双区布局，增删行着色，hunk 头灰底 |
| 错误：读取失败 | 文件被外部移动/权限不足 | 右侧错误占位卡 + 原因说明 |
| 边界态：二进制/超大文件 | 无法按行渲染 | 占位提示「二进制文件，无法显示 Diff」/「文件过大，仅显示前 N 行」并给出文件路径 |

---

## 6. 页面四：Settings（Models / DSH / Permissions）

### 6.1 信息结构（§17、§32、§12）

```text
┌───────────────────────────────────────────────┐
│ Settings        [Models] [DSH] [Permissions]  │ ← Tab 三项，即 §37 原文
├───────────────────────────────────────────────┤
│ Models (§17)                                  │
│  Provider 列表: st · openai · internal …       │
│  [Add Provider]                               │
│  ── 编辑表单 ──                                │
│   Provider 名称: st                            │
│   API Type:      OpenAI Completions ▾          │
│   Base URL:      https://example.com/v1        │
│   API Key:       ********   （保存后仅掩码）      │
│   Models:        deepseek-v4-flash, glm-5.2    │
│                                               │
│ DSH (§32)                                     │
│   DSH 路径: ~/.dsh/bin/dsh  [Choose DSH Path]  │
│   Runtime 状态: ● Ready / stderr 查看           │
│   [Install]（未安装时）                         │
│                                               │
│ Permissions (§12)                             │
│   Agent 权限模式: ○ Ask ● Auto Edit ○ Full Auto │
│   Workspace 根目录: /home/user/project（只读展示，§7.3）│
└───────────────────────────────────────────────┘
```

- **Models**（§17）：Provider 配置表单字段与文档一致（Provider / API Type / Base URL / API Key / Models）；保存写入 `~/.dsh/settings.yaml`，凭据写入 `~/.dsh/.credentials.yaml`（作为说明文字呈现，UI 不暴露文件编辑器）。API Key 保存后一律掩码显示，不允许明文回看。
- **DSH**（§32）：路径检测与 Choose DSH Path、Install 引导、Runtime 状态与 stderr 查看。对应启动方式 `dsh --profile desktop --stdio/--socket` 仅作说明文字（技术细节归开发总监拆解）。
- **Permissions**（§12）：Ask / Auto Edit / Full Auto 单选；下方只读展示当前 Workspace 根目录以明示隔离边界（§7.3）。Docker Sandbox 等选项不出现（§36、§28 P1）。

### 6.2 交互流程

1. 任意页面顶栏齿轮进入 Settings，Tab 切换三个分区，关闭后返回来源页。
2. Add Provider → 填写表单 → 保存 → 校验通过后写入配置 → 返回列表；此后 Workspace 顶栏模型下拉可选到新模型（§17→§18 链路）。
3. 编辑已有 Provider：API Key 字段留空表示不变更，填入新值才覆盖（保证不明文回显）。
4. DSH 未安装时进入 DSH Tab → Install 或 Choose DSH Path → 保存后重试检测（§32）。
5. 权限模式保存后立即对后续 Run 生效；Workspace 顶栏徽标同步更新。

### 6.3 状态矩阵

| 状态 | 触发条件 | UI 表现 |
| --- | --- | --- |
| 空态：无 Provider | 首次使用 | Models 列表空态 + Add Provider 主按钮 |
| 加载中 | 读取现有配置 | 表单区 skeleton；已有值回填后可见 |
| 校验错误 | 必填缺失 / URL 格式错误 | 字段级红色错误文案，焦点定位首个出错字段 |
| 保存成功 | 写入成功 | 轻量成功提示；API Key 即转掩码 |
| 错误：保存失败 | 文件写入/权限问题 | 错误提示含原因（如 credentials 文件权限校验失败，§35） |
| DSH 未安装 | 检测失败 | Install / Choose DSH Path 双动作（§32） |
| disabled：运行中改配置 | Agent Run 进行中 | 允许修改但标注「将在下次 Run 生效」，避免运行中状态歧义 |

---

## 7. 五类关键状态全局规范（本次指令点名）

### 7.1 空态
四页均不得出现纯空白区域：空态 = 图标/插画 + 一句话说明 + 一个主操作按钮（Home→Open Project；Workspace→New Session；Diff→返回；Settings→Add Provider）。

### 7.2 加载中
三种标准表现：列表骨架屏（Session/Provider/Recent Projects）、环形 spinner（Runtime 连接、diff 计算）、字符级流式光标（Chat streaming）。加载占位高度须与最终内容一致，避免布局跳动。

### 7.3 Agent 运行中
唯一性原则：同一时刻至多一个 Run 处于运行态（单会话维度）。运行中固定表现为：流式光标、进行中 Tool 卡片 spinner、Stop 按钮替代发送按钮（一键可达，§22）、输入框禁用、右栏 Changes 实时更新。Run 结束（completed/cancelled/error）必须解除以上全部锁定态。

### 7.4 错误
所有错误遵循「发生了什么 + 为什么 + 建议动作」三段式文案，逐类落位：
- DSH 未安装 → Home 横幅 + Install / Choose DSH Path（§32）；
- Runtime 启动失败 → stderr 面板 + 重试（§32）；
- Model API Error → 消息流内联错误卡，区分 401 Invalid API Key / 404 Endpoint not found / 429 Rate Limit（§32 原文三例）；
- Agent Crash → Session 不丢失 + Restart Runtime / Resume Session（§32）。
禁止只弹 toast 不留现场；禁止向日志写入 API Key（§33/§35）。

### 7.5 Approval 弹窗（§12、§13）
- **触发**：`approval_required` 事件；Ask 模式下所有危险操作询问，Auto Edit 下危险操作仍询问，Full Auto 下 L2 级仍强制确认（§12 + §13 Level 2 默认必须确认）。
- **形态**：应用级模态弹窗，遮罩阻断其余交互；焦点进入弹窗并在弹窗内循环（focus trap）。
- **内容**：标题（如「Agent 请求执行危险操作」）、工具名、风险等级徽标（L0 灰 / L1 黄 / L2 红，附字母标识不只靠颜色，§13）、完整命令或参数全文（等宽字体、完整可读、不允许截断省略——满足 §35 Dangerous Command Approval 知情要求）；若目标路径越出当前 Workspace，必须显著标注「访问 Workspace 外部目录」并要求明确授权（§7.3/§35）。
- **动作**：Allow / Allow Once / Reject 三键并排（§12 示例原文）；Reject 与允许类按钮视觉可区分。Allow 与 Allow Once 的作用域语义（会话级/单次级）以技术方案定义为准，UI 文案保持与文档示例逐字一致。

---

## 8. 视觉验收要求（可测条目）

| # | 要求 | 判定方式 |
| --- | --- | --- |
| V1 | Workspace 三栏同屏：1280×800 下 Sessions / Agent / Changes 三栏同时可见，比例约 220px / 弹性 / 300px，分隔线清晰（§8 线框） | 截图比对 |
| V2 | 性能：冷启动 <3s 内渲染 Home 首屏；DSH 就绪后 <2s 内状态灯转绿（§34） | 计时 |
| V3 | Streaming：message_delta 增量追加渲染，无整段重绘、闪烁或滚动跳动（§21/§34） | 长回复观察 |
| V4 | Tool Call 卡片必含五要素：工具名、参数摘要、状态图标（进行/成功/失败）、耗时、输出展开区；Shell 卡片内嵌 Terminal Output Viewer 且命令与输出等宽字体（§14/§5.4） | 走查 |
| V5 | Changes 徽标 M/A/D 以字母+颜色双编码（M 黄、A 绿、D 红），路径等宽字体（§10） | 走查 |
| V6 | Approval 弹窗：模态遮罩 + focus trap；命令全文等宽完整可读；L2 红色等级标识；Allow/Allow Once/Reject 三键齐备且 Reject 视觉可区分（§12/§13/§35） | 触发 L2 命令实测 |
| V7 | API Key 安全：password 型输入；保存后列表仅显示掩码与「已配置」，全应用任何界面无明文回显（§17/§35） | 全局搜索走查 |
| V8 | Diff 仅 Unified：无 Side-by-side 切换控件；删除行红底、新增行绿底、行号列、hunk 头灰底、等宽字体、长行横向滚动（§11） | 截图比对 |
| V9 | 空态齐备：四页空态均有图标+文案+主操作按钮，无空白死区 | 清空数据走查 |
| V10 | 加载态齐备：骨架屏/spinner/流式光标三种表现按场景正确出现，占位不引起布局跳动 | 弱网/慢启动模拟 |
| V11 | 错误态齐备：§32 四类错误场景逐一可复现且各有专属文案与建议动作 | 注入故障实测 |
| V12 | 对比度：正文对比度 ≥ WCAG AA（4.5:1）；风险/状态标识不单独依赖颜色（附 L0/L1/L2、M/A/D 字符） | 取色检测 |
| V13 | 键盘可达：主要动作 Tab 可达，Enter 发送、Shift+Enter 换行；运行中 Stop 一键可达 | 键盘走查 |
| V14 | 文案语言：界面中文为主，代码/命令/路径一律等宽西文字体 | 走查 |
| V15 | disabled 态：未配置 Provider 时发送禁用并有跳转指引；运行中输入/模型切换/模式切换禁用 | 状态实测 |
| V16 | 视觉基调：浅色主题为主，单一品牌主色，语义色仅 success/warning/danger 三族；间距与圆角全站一致（实现阶段以设计走查为准） | 设计走查 |

---

## 9. 事件完整性自检

§21 全部事件类型均已在 §2.2 映射到具体 UI 呈现，无遗漏事件、无凭空 UI 状态；§39 MVP 验收标准中的 Workspace / Chat / Tool / Diff / Approval / Stop / Session / Provider 八项均可通过本规范的页面与状态矩阵直接推导出测试路径。

---

## 10. 待 PM 范围基线确认的边界项（非新增功能，仅文档内歧义）

1. **Diff 的 Accept / Reject / Revert file 与 Prev/Next change**（§11 全部列出，但「MVP 至少支持 Unified Diff」为唯一下限）：建议 MVP 最小集 = Unified 查看 + 文件切换 + Prev/Next；Accept/Reject/Revert 与 §12 Approval 机制的边界需 PM 裁定阶段归属，UI 已预留文件头操作位。
2. **Agent Mode 选择器**（§27 Ask/Plan/Agent/Review）：Plan/Review 在 §40 属 Phase 2；Chat 顶部是否在 MVP 先放「仅 Agent 档」的选择器或完全不放，待 PM 基线。
3. **Sub-Agent 消息形态**（§5.4/§9）：仅保留消息卡片渲染样式占位；Multi-Agent 能力本身为 §36 明确不做项。
