/**
 * Two-step confirmation dialog for DESTRUCTIVE actions (S-5 裁定②).
 *
 * Accessibility contract (DSHA-6 P1-1 review fix):
 *  - Stage 1 initial focus lands on the SAFE action (取消), never the
 *    destructive one; Stage 2 moves focus to the danger confirm button.
 *  - Tab / Shift+Tab are trapped inside the dialog (hard wrap-around).
 *  - On close, focus is restored to the element that opened the dialog.
 *  - While `busy`, the dialog is not dismissible (Esc, backdrop click) and
 *    the confirm button is disabled + shows a spinner until the result.
 *    The 取消/继续/confirm buttons keep their disabled/busy states.
 *
 * This is UI gating only — actual execution stays subject to the L2 approval
 * level.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button, Spinner } from './ui';
import {
  collectFocusables,
  cycleFocusIndex,
  ignoreCloseWhileBusy,
  pickInitialFocus
} from './dialog-focus';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Stage-1 body: what will happen. */
  children: ReactNode;
  confirmLabel?: string;
  stage2Label?: string;
  cancelLabel?: string;
  /** Extra warning line repeated on stage 2. */
  warning?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = '确认执行',
  stage2Label = '继续',
  cancelLabel = '取消',
  warning,
  busy = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps): JSX.Element | null {
  const [stage, setStage] = useState<1 | 2>(1);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const prevOpenRef = useRef(open);

  /* ---- reset to stage 1 and park the trigger for focus restore ---- */
  useEffect(() => {
    if (open) {
      setStage(1);
      if (!prevOpenRef.current) {
        restoreFocusRef.current = document.activeElement as HTMLElement | null;
      }
    } else if (prevOpenRef.current) {
      restoreFocusRef.current?.focus?.();
      restoreFocusRef.current = null;
    }
    prevOpenRef.current = open;
  }, [open]);

  /* ---- initial focus: stage 1 → cancel (safe), stage 2 → confirm ---- */
  useEffect(() => {
    if (!open) return;
    if (stage === 2) {
      confirmRef.current?.focus();
    } else {
      const preferred = cancelRef.current;
      const list = dialogRef.current ? collectFocusables(dialogRef.current) : [];
      pickInitialFocus(list, preferred)?.focus();
    }
  }, [open, stage]);

  /* ---- focus trap + Esc (gated by busy) ---- */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Tab') {
        const dialog = dialogRef.current;
        if (dialog == null) return;
        const els = collectFocusables(dialog);
        if (els.length === 0) {
          e.preventDefault();
          return;
        }
        const current = document.activeElement as HTMLElement | null;
        const idx = els.indexOf(current as never);
        const next = cycleFocusIndex(els.length, idx, e.shiftKey);
        if (next >= 0 && els[next]) {
          els[next]?.focus();
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (ignoreCloseWhileBusy(busy)) return; // busy ⇒ not dismissible
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div className="confirm-backdrop" onClick={busy ? undefined : onCancel}>
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="confirm-title">{title}</h3>
        <div className="confirm-body">{children}</div>
        {stage === 2 && warning != null && (
          <p className="confirm-warning" role="alert">
            ⚠ {warning}
          </p>
        )}
        <div className="confirm-actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            data-dialog-cancel=""
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          {stage === 1 ? (
            <Button variant="danger" onClick={() => setStage(2)}>
              {stage2Label}
            </Button>
          ) : (
            <button
              ref={confirmRef}
              type="button"
              className="btn btn-danger"
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={onConfirm}
            >
              {busy && <Spinner label="执行中" />}
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
