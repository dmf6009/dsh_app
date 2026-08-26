## DSHA-5 UI/UE acceptance — `main@f159b95`

结论：**FAIL**。三栏、消息状态、Approval 安全默认、恢复入口和阶段占位的实现证据符合范围要求；但 Workspace 在可缩放小窗口下发生横向溢出，底部主操作（运行时为 Stop）不能持续可达，属于发布阻断。

### 阻断项：小窗口下主操作与 Changes 超出视口

- 严重级别：P1 / 发布阻断
- 环境：Linux Xvfb，Electron 33.2.1，`main@f159b953d3510aff1195203b96e154617b90a874`
- 复现：构建并启动应用，进入 Workspace，把窗口缩放至 500×400。
- 实际：`innerWidth=500`，但 `bodyScrollWidth=798`；Workspace 宽 798px。中栏为 `x=240..558`，底部主操作为 `x=470..542`，仅 30px 位于视口内；Changes 为 `x=558..798`，完全不可见。页面自身禁用横向滚动，无法通过水平滚动恢复操作。
- 期望：在应用允许的全部窗口尺寸下，Stop/停止中持续完整可见且可操作；三栏应响应式折叠/抽屉化，或 BrowserWindow 设置与布局匹配的最小尺寸，不能让关键操作离开视口。
- 对应状态：idle 时“发送”已被裁切；running/awaiting_cancel 复用同一 composer 槽位，因此“停止/停止中”同样被裁切。

### 逐项核验

- 三栏与阶段边界：Sessions 明示内存列表；Changes 明示真实 Diff 由 P1-C 提供；Sub-Agent 卡明示完整视图由 P1-D 提供。未误导为完整支持。
- 七类消息：Text streaming cursor、Plan、Tool/Terminal、File Read/Edit、Sub-Agent、Summary/notice 均有独立结构；running/completed/error/cancelled 使用文字、符号与语义色共同表达。
- 运行锁与取消：运行中禁用输入和模型选择；取消后仅 `run_cancelled` 解锁的行为已有 reducer/E2E 与 QA 证据。默认尺寸下 composer 固定于中栏底部。
- Approval：拒绝默认聚焦并有危险强调；Escape 等价 Reject；焦点陷阱存在；完整命令换行且内部滚动；L0/L1/L2 有字母和语义标签；越界及投递失败均为 alert，失败时模态保持并提示重试。
- crash/restart/resume：崩溃横幅提供两条恢复路径并显示 exit/signal；启动失败显示诊断与重试；状态转换无误导闪现已有集成测试与 QA 回归。
- 空/错/禁用态：Conversation、Changes、Sessions 边界提示清楚；发送失败、审批投递失败、启动失败、crash 均有可恢复反馈；禁用态具备文案与视觉区分。

### 环境边界与发布门禁

- Xvfb 无法覆盖真实 GPU、系统托盘、钥匙串、原生文件选择器和 Windows/macOS 字体、缩放及原生交互。
- `smoke:dsh` 因 desktop profile 未安装而预期 SKIP。
- 修复响应式阻断后，需至少在 Windows/macOS 真机复验 100%/125%/150% 缩放、最小窗口、长命令 Approval、长输出运行态 Stop、键盘焦点陷阱及原生集成；这些是发布门禁风险，不是当前实现缺陷判定。

