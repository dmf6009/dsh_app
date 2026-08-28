/**
 * §32 unified error copy — the four error scenarios each surface a three-part
 * structure: 「发生了什么 / 为什么 / 建议动作」, plus a concrete出路 (recovery
 * action). Kept in shared so main (redaction + framing) and renderer (banners,
 * inline error cards) use one source of truth.
 *
 *   1. DSH 未安装          → Install / Choose DSH Path
 *   2. Runtime 启动失败     → stderr 面板
 *   3. Model API 401/404/429 → 消息流内联错误卡（保留原始可诊断信息）
 *   4. Agent Crash         → Session 保留 + Restart Runtime / Resume Session
 *
 * Plus the §15 persistence-layer failures (save/delete), framed with the same
 * three-part structure so a failed checkpoint is never silently swallowed.
 *
 * Diagnostic detail (stderr tail, provider code/message) is preserved verbatim
 * so support can diagnose; secrets are stripped upstream of these functions by
 * the runtime-log redaction choke point (§33).
 */

export type ErrorScenario =
  | 'dsh_not_found'
  | 'runtime_startup_failed'
  | 'model_api'
  | 'agent_crash'
  | 'session_persist';

export interface ErrorCopy {
  scenario: ErrorScenario;
  /** 「发生了什么」 — one line, user-facing. */
  what: string;
  /** 「为什么」 — why it happened, plain language. */
  why: string;
  /** 「建议动作」 — what to do next, plain language. */
  action: string;
  /**
   * Raw diagnostic detail carried through verbatim (exit code, stderr tail,
   * provider message). Displayed in a preformatted block, never truncated.
   * Already secret-redacted before reaching here.
   */
  detail?: string;
  /** Machine-readable provider code when available (401/404/429…). */
  code?: string | number;
}

/** Map a Model API provider code to the §32 three-part copy (scenario 3). */
export function modelApiErrorCopy(
  message: string,
  code?: string | number
): ErrorCopy {
  const raw = message.trim();
  const c = String(code ?? '');
  let what: string;
  let why: string;
  let action: string;
  switch (c) {
    case '401':
      what = '模型接口认证失败（401）';
      why = 'API Key 无效、未配置，或已被吊销。';
      action = '前往 Settings 检查该 Provider 的 API Key（已保存的密钥不会回显），更新后重试。';
      break;
    case '404':
      what = '模型或接口不存在（404）';
      why = 'Base URL 或模型名拼写有误，或该 Provider 尚未提供此模型。';
      action = '前往 Settings 核对 Base URL 与模型名，必要时刷新模型列表。';
      break;
    case '429':
      what = '请求过于频繁或额度用尽（429）';
      why = '触发了 Provider 的速率限制或配额上限。';
      action = '稍候片刻后重试；如持续，请在 Provider 侧提升限额或切换模型。';
      break;
    default:
      what = '模型接口返回错误';
      why = code === undefined || code === null || code === '' ? 'Provider 返回了非预期响应。' : `Provider 返回了错误码 ${code}。`;
      action = '检查 Runtime 日志中的原始信息，核实配置后重试。';
      break;
  }
  return {
    scenario: 'model_api',
    what,
    why,
    action,
    detail: raw,
    code
  };
}

/** Agent Crash copy (scenario 4). `detail` is the redacted stderr tail. */
export function agentCrashCopy(exitCode: number | null, signal: string | null, detail?: string): ErrorCopy {
  return {
    scenario: 'agent_crash',
    what: 'Runtime 已崩溃',
    why: 'DSH 子进程异常退出，但会话已保留——你的对话历史不会丢失。',
    action: '选择「重启 Runtime」拉起一个新进程，或「恢复会话」在重启后继续。',
    detail: detail ?? `exit=${exitCode ?? '—'} signal=${signal ?? '—'}`
  };
}

/** Runtime startup-failure copy (scenario 2). `detail` is stderr tail / startup error. */
export function runtimeStartupFailedCopy(detail?: string): ErrorCopy {
  return {
    scenario: 'runtime_startup_failed',
    what: 'Runtime 启动失败',
    why: 'DSH 子进程未能进入就绪态（启动超时、进程提前退出或 spawn 失败）。',
    action: '查看下方 stderr 诊断信息后点击「重试启动」；若仍失败，请在 Settings 检查 DSH 路径。',
    detail
  };
}

/** DSH not found copy (scenario 1). */
export function dshNotFoundCopy(reason?: string): ErrorCopy {
  return {
    scenario: 'dsh_not_found',
    what: '未找到 DeepSeek Harness',
    why: reason ?? '未检测到可用的 dsh 运行时。Desktop 需要 dsh CLI 才能驱动 Agent。',
    action: '安装 dsh CLI（确保 dsh 在 PATH 中），或点击「Choose DSH Path」指定已安装的可执行文件路径。',
  };
}

/* ---- Session persistence errors (§15/§32: save/delete must not fail silently) ---- */

/**
 * Session-save failure copy. `detail` is the store's raw error (e.g. an fs
 * message or a validation rejection reason). The user must be able to tell
 * the transcript is NOT safely on disk yet — otherwise they close the app and
 * lose the conversation (AC-12 regression).
 */
export function sessionSaveFailedCopy(detail?: string): ErrorCopy {
  return {
    scenario: 'session_persist',
    what: '会话保存失败',
    why: '会话记录未能写入磁盘（磁盘错误、目录权限问题，或记录未通过完整性校验）。当前对话仍显示在界面中，但尚未成功落盘——此时关闭应用可能丢失这段历史。',
    action: '继续对话会自动再次尝试保存；也可以手动切换一次会话触发保存。若持续失败，请检查磁盘空间与 ~/.dsh/desktop 目录权限，并避免多个应用实例同时打开同一工作区。',
    detail
  };
}

/**
 * Session-delete failure copy. `detail` is the store's raw error. The store
 * deliberately keeps the index unchanged on delete failure so the list never
 * claims a deletion that did not happen on disk — the copy explains that.
 */
export function sessionDeleteFailedCopy(detail?: string): ErrorCopy {
  return {
    scenario: 'session_persist',
    what: '会话删除失败',
    why: '会话文件在磁盘上未能移除（可能被其他进程占用）。为避免列表与磁盘状态分裂，本次删除未生效，会话仍保留在列表中。',
    action: '关闭可能占用该文件的其他程序后重试；文件仍完整保留在磁盘上，对话内容不会丢失。',
    detail
  };
}

/**
 * Copy for a create/switch transition that failed at the store level (the
 * outgoing checkpoint already succeeded at this point, so unlike a save
 * failure the conversation IS safely on disk).
 */
export function sessionOpFailedCopy(op: '新建' | '切换', detail?: string): ErrorCopy {
  return {
    scenario: 'session_persist',
    what: `会话${op}失败`,
    why: '当前会话已成功保存，但目标会话操作未完成，界面仍停留在当前会话。',
    action: '请重试该操作；若持续失败，请检查磁盘空间与 ~/.dsh/desktop 目录权限。',
    detail
  };
}

/**
 * Single-string projection of a session persistence error (same shape as the
 * chat layer's `describeError`): 发生了什么 / 原因 / 建议 / 原始信息, one per
 * line, so a copy/paste into a bug report keeps the diagnostics.
 */
export function describeSessionError(copy: ErrorCopy): string {
  return [copy.what, `原因：${copy.why}`, `建议：${copy.action}`, copy.detail ? `原始信息：${copy.detail}` : null]
    .filter((line): line is string => line !== null && line !== '')
    .join('\n');
}
