/**
 * Two-step confirmation dialog for DESTRUCTIVE actions (S-5 裁定②).
 *
 * Stage 1 explains what will happen; stage 2 repeats the consequence and
 * requires an explicit danger-button press. Esc / 取消 abort at any stage,
 * focus starts on the safe action and lands on the danger button only at
 * stage 2. This is UI gating only — actual execution stays subject to the
 * L2 approval level.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button, Spinner } from './ui';

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
  const stage2Ref = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setStage(1);
  }, [open]);

  useEffect(() => {
    if (open && stage === 2) stage2Ref.current?.focus();
    else if (open && stage === 1) dialogRef.current?.focus();
  }, [open, stage]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="confirm-backdrop" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
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
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          {stage === 1 ? (
            <Button variant="danger" onClick={() => setStage(2)}>
              {stage2Label}
            </Button>
          ) : (
            <button
              ref={stage2Ref}
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
