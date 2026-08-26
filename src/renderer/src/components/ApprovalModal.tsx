/**
 * App-level Approval modal (issue DSHA-5, §12/§13 + S-4).
 *
 * Hard requirements encoded here:
 * - focus trap: Tab / Shift+Tab cycle inside the dialog, focus starts on the
 *   safe default (拒绝) and Escape closes as reject;
 * - the full command is rendered monospace with wrapping — never truncated;
 * - risk badge shows letter + colour (L0 gray, L1 amber, L2 red);
 * - out-of-boundary operations show an explicit authorization banner;
 * - closing the modal in any way ≙ 拒绝 (reject once) — the safe default.
 */

import { useCallback, useEffect, useRef } from 'react';

import type { ApprovalRequestPayload } from '../../../shared/approval-protocol';

const LEVEL_CLASS: Record<string, string> = {
  L0: 'lvl-l0',
  L1: 'lvl-l1',
  L2: 'lvl-l2'
};

const LEVEL_LABEL: Record<string, string> = {
  L0: 'L0 只读',
  L1: 'L1 常规',
  L2: 'L2 危险'
};

export interface ApprovalModalProps {
  payload: ApprovalRequestPayload | null;
  /** Resolve the request; `decision` is what the user picked. */
  onRespond: (requestId: string, decision: 'allow' | 'reject', scope: 'once' | 'session') => void;
}

export function ApprovalModal({ payload, onRespond }: ApprovalModalProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);

  // Focus the safe default on open; restore nothing (the underlying page is
  // inert while the modal is up).
  useEffect(() => {
    if (payload !== null) {
      rejectRef.current?.focus();
    }
  }, [payload]);

  const respond = useCallback(
    (decision: 'allow' | 'reject', scope: 'once' | 'session'): void => {
      if (payload === null) return;
      onRespond(payload.requestId, decision, scope);
    },
    [payload, onRespond]
  );

  // Focus trap + Escape-as-reject.
  useEffect(() => {
    if (payload === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        respond('reject', 'once');
        return;
      }
      if (event.key !== 'Tab') return;
      const container = dialogRef.current;
      if (container === null) return;
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [payload, respond]);

  if (payload === null) return null;

  const level = String(payload.level ?? 'L1');
  const levelClass = LEVEL_CLASS[level] ?? 'lvl-l1';
  const levelLabel = LEVEL_LABEL[level] ?? `L${level.replace(/^L/, '')}`;

  return (
    <div className="modal-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="approval-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
      >
        <header className="approval-head">
          <h2 id="approval-title">需要你的批准</h2>
          <span className={`risk-badge ${levelClass}`}>{levelLabel}</span>
        </header>

        <p className="approval-summary">
          {payload.summary?.trim() !== '' ? payload.summary : 'Runtime 请求执行以下操作'}
        </p>

        <dl className="approval-meta">
          {payload.tool !== undefined && (
            <>
              <dt>工具</dt>
              <dd>
                {payload.tool}
                {payload.category !== undefined && (
                  <span className="category-chip">{payload.category}</span>
                )}
              </dd>
            </>
          )}
        </dl>

        {typeof payload.command === 'string' && payload.command.trim() !== '' && (
          <>
            <div className="approval-command-label">完整命令（不截断）</div>
            <pre className="approval-command" data-testid="approval-command">
              {payload.command}
            </pre>
          </>
        )}

        {payload.needsBoundaryAuthorization && (
          <div className="oob-banner" role="alert">
            ⚠ 该操作涉及 Workspace 边界之外的路径：
            {payload.outsidePaths.length > 0 ? payload.outsidePaths.join('、') : '（见命令）'}
            。允许即表示你明确授权这些路径。
          </div>
        )}

        {payload.reasons.length > 0 && (
          <ul className="approval-reasons">
            {payload.reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        )}

        <footer className="approval-actions">
          <button type="button" className="btn btn-secondary" onClick={() => respond('allow', 'session')}>
            本次会话均允许
          </button>
          <button type="button" className="btn btn-primary" onClick={() => respond('allow', 'once')}>
            允许一次
          </button>
          <button
            ref={rejectRef}
            type="button"
            className="btn btn-danger approval-reject"
            data-testid="approval-reject"
            onClick={() => respond('reject', 'once')}
          >
            拒绝
          </button>
          <span className="approval-close-hint">关闭窗口 ≙ 拒绝</span>
        </footer>
      </div>
    </div>
  );
}
