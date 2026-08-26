/**
 * Approval Engine — pure rule matrix (issue DSHA-5, requirements §12/§13,
 * S-1 semantics).
 *
 * Decision space:
 *   - 'allow'  proceed without bothering the user (rule-matrix grant);
 *   - 'ask'    show the app-level approval modal;
 *   - 'deny'   refuse outright (only for paths the boundary service cannot
 *              verify at all — we never authorize what we cannot resolve).
 *
 * Matrix (mode × risk level):
 *   ┌───────────┬────────┬────────────────────────────┬────────────┐
 *   │           │   L0   │            L1              │     L2     │
 *   │ ask       │ allow  │ ask                        │ ask        │
 *   │ auto_edit │ allow  │ allow                      │ ask        │
 *   │ full_auto │ allow  │ allow                      │ ask        │
 *   └───────────┴────────┴────────────────────────────┴────────────┘
 * Overrides applied after the matrix:
 *   - operation touches paths outside the workspace boundary
 *     (boundary.needsAuthorization) → forced 'ask' with an explicit
 *     out-of-boundary authorization reason (§35 / S-4);
 *   - path cannot be resolved/verified at all → 'deny';
 *   - locally derived risk may only ever escalate a runtime-claimed level,
 *     never de-escalate it.
 */

import type { PermissionMode } from '../../shared/settings';
import type { ActionCategory } from '../../shared/approval-protocol';
import type { RiskLevel } from '../../shared/protocol/types';

export type { ActionCategory };

export interface OperationDescriptor {
  tool?: string;
  /** Command line for shell-type operations. */
  command?: string;
  /** Paths the operation will touch (workspace-relative or absolute). */
  paths?: readonly string[];
  /** Risk level as claimed by the runtime, if any. */
  claimedLevel?: RiskLevel | string;
}

export interface Classification {
  level: RiskLevel;
  category: ActionCategory;
  /** Human-readable justification recorded with the request. */
  basis: string;
}

export type ApprovalDecision = 'allow' | 'ask' | 'deny';

export interface BoundaryVerdict {
  /**
   * True when at least one target path resolves outside the workspace but is
   * authorizable — the modal must demand explicit confirmation (S-4).
   */
  needsAuthorization: boolean;
  /** True when some path cannot be verified (symlink loops, missing root…). */
  unverifiable: boolean;
}

export interface ApprovalEvaluation {
  decision: ApprovalDecision;
  level: RiskLevel;
  category: ActionCategory;
  needsBoundaryAuthorization: boolean;
  reasons: string[];
}

/* ------------------------------------------------------------------ */
/* Risk classification                                                 */
/* ------------------------------------------------------------------ */

const READ_TOOLS = new Set([
  'read',
  'read_file',
  'view',
  'grep',
  'search',
  'find',
  'glob',
  'list',
  'ls'
]);
const EDIT_TOOLS = new Set(['edit', 'write', 'write_file', 'create_file', 'apply_patch', 'patch']);
const SHELL_TOOLS = new Set(['shell', 'bash', 'exec', 'terminal', 'run_command']);
const NETWORK_TOOLS = new Set(['web_fetch', 'fetch', 'http', 'download']);
const SUBAGENT_TOOLS = new Set(['subagent', 'task', 'spawn_agent', 'agent']);

/** First tokens that are unambiguously read-only when run in a shell. */
const READ_ONLY_COMMANDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'rg',
  'find',
  'pwd',
  'which',
  'file',
  'wc',
  'du',
  'stat',
  'echo',
  'tree',
  'diff'
]);

/** Build/test invocations count as normal (L1) shell work. */
const BUILD_TEST_PATTERN =
  /\b(npm|npx|pnpm|yarn|bun)\s+(test|run\s+(test|build|lint)|ci|install|build)\b|\bpytest\b|\bpython3?\s+-m\s+pytest\b|\bmake\b|\bcargo\s+(test|build|check)\b|\bgo\s+(test|build|vet)\b/i;

const GIT_READ_PATTERN = /^git\s+(status|log|diff|show|branch|remote|tag)\b/i;

/** §13 destructive markers → always L2 regardless of mode. */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\bsudo\b/,
  /\brm\s+(-[a-z]*[rR][a-z]*\s+)/, // rm -r / -rf / -fr …
  /\bgit\s+push\b/i,
  /\bgit\s+reset\b/i,
  /\bgit\s+clean\b/i,
  /\bnpm\s+publish\b/i,
  /\byarn\s+publish\b/i,
  /\bpnpm\s+publish\b/i,
  /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  /\b(shutdown|reboot|poweroff)\b/i
];

/**
 * Derive (level, category) for an operation. Pure and exhaustive: every
 * input lands on exactly one cell of the classification table so the
 * full-combination tests stay deterministic.
 */
export function classifyOperation(op: OperationDescriptor): Classification {
  const derived = deriveClassification(op);
  // Trust-but-verify: a runtime-claimed level may be escalated locally but
  // never downgraded.
  const claimed = normalizeClaimedLevel(op.claimedLevel);
  if (claimed === null || rank(claimed) <= rank(derived.level)) return derived;
  return { ...derived, level: claimed, basis: `${derived.basis}; runtime 标注 ${claimed}` };
}

function deriveClassification(op: OperationDescriptor): Classification {
  const tool = (op.tool ?? '').toLowerCase();
  const command = (op.command ?? '').trim();

  if (tool && READ_TOOLS.has(tool)) return { level: 'L0', category: 'read', basis: `只读工具 ${tool}` };
  if (tool && NETWORK_TOOLS.has(tool))
    return { level: 'L1', category: 'network', basis: `网络工具 ${tool}` };
  if (tool && SUBAGENT_TOOLS.has(tool))
    return { level: 'L1', category: 'shell', basis: `子代理任务 ${tool}` };
  if (tool && EDIT_TOOLS.has(tool)) {
    // File edits stay L1 unless they target something obviously systemic.
    return { level: 'L1', category: 'edit', basis: `文件编辑工具 ${tool}` };
  }

  // Shell-shaped operations are classified from the command line.
  if (!tool || SHELL_TOOLS.has(tool) || tool === 'git') {
    if (command !== '') return classifyCommand(command);
  }
  if (op.paths && op.paths.length > 0) {
    return { level: 'L1', category: 'edit', basis: '文件操作（按路径处理）' };
  }
  // Fully unknown operation shape → conservative middle ground: follows the
  // mode matrix (Ask asks, Auto Edit/Full Auto allow) instead of spamming
  // every call into the L2 always-confirm bucket.
  return { level: 'L1', category: 'system', basis: '未识别的操作类型，按常规风险处理' };
}

export function classifyCommand(command: string): Classification {
  const trimmed = command.trim();
  const firstToken = trimmed.split(/\s+/)[0]?.toLowerCase() ?? '';

  // Git commands are judged inside their own family so destructive
  // subcommands keep the `git` category instead of degrading to `system`.
  if (/^git(\.exe)?\s/i.test(trimmed)) {
    if (GIT_READ_PATTERN.test(trimmed)) {
      return { level: 'L0', category: 'git', basis: '只读 git 子命令' };
    }
    if (/\bgit\s+(push|reset|clean)\b/i.test(trimmed)) {
      return { level: 'L2', category: 'git', basis: '破坏性 git 子命令（push/reset/clean）' };
    }
    return { level: 'L1', category: 'git', basis: '本地 git 变更操作' };
  }

  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { level: 'L2', category: 'system', basis: `命中危险命令规则 ${pattern}` };
    }
  }
  if (BUILD_TEST_PATTERN.test(trimmed)) {
    return { level: 'L1', category: 'shell', basis: '构建/测试命令' };
  }
  if (/^(curl|wget)\b/i.test(trimmed)) {
    return { level: 'L1', category: 'network', basis: '网络获取命令' };
  }
  if (READ_ONLY_COMMANDS.has(firstToken)) {
    return { level: 'L0', category: 'read', basis: `只读命令 ${firstToken}` };
  }
  return { level: 'L1', category: 'shell', basis: '常规 Shell 命令' };
}

function normalizeClaimedLevel(value: RiskLevel | string | undefined): RiskLevel | null {
  if (value === 'L0' || value === 'L1' || value === 'L2') return value;
  return null;
}

function rank(level: RiskLevel): number {
  return level === 'L0' ? 0 : level === 'L1' ? 1 : 2;
}

/* ------------------------------------------------------------------ */
/* Mode × risk matrix                                                  */
/* ------------------------------------------------------------------ */

/** The bare S-1 matrix: no overrides applied. */
export function matrixDecision(mode: PermissionMode, level: RiskLevel): ApprovalDecision {
  switch (level) {
    case 'L0':
      return 'allow';
    case 'L1':
      return mode === 'ask' ? 'ask' : 'allow';
    case 'L2':
      return 'ask';
  }
}

/**
 * Full evaluation: matrix + boundary overrides. `boundary` carries the
 * aggregated verdict over all target paths (computed by the caller via the
 * P1-A boundary service).
 */
export function evaluateApproval(
  mode: PermissionMode,
  op: OperationDescriptor,
  boundary?: BoundaryVerdict
): ApprovalEvaluation {
  const classification = classifyOperation(op);
  const reasons: string[] = [classification.basis];
  const needsAuthorization = boundary?.needsAuthorization === true;
  const unverifiable = boundary?.unverifiable === true;

  let decision = matrixDecision(mode, classification.level);
  if (decision === 'allow') reasons.push(`${classification.level} 在 ${mode} 模式下自动放行`);
  else reasons.push(`${classification.level} 需要用户确认`);

  if (needsAuthorization) {
    decision = 'ask';
    reasons.push('操作涉及 Workspace 边界之外的路径，需要明确授权');
  }
  if (unverifiable) {
    decision = 'deny';
    reasons.push('目标路径无法通过边界服务验证，已拒绝执行');
  }

  return {
    decision,
    level: classification.level,
    category: classification.category,
    needsBoundaryAuthorization: needsAuthorization,
    reasons
  };
}
