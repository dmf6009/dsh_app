/**
 * Diff Viewer page (issue DSHA-6).
 *
 *   Left   — Changed Files list (aggregated ChangeRecords) with selected state
 *   Right  — Monaco read-only UNIFIED diff (renderSideBySide:false),
 *            Prev/Next hunk navigation with hard disabled ends, Revert file
 *            behind a two-step destructive confirmation (S-5 裁定②)
 *
 * Large files stream into the models in bounded chunks (≥1MB ⇒ chunked) so a
 * multi-megabyte diff never freezes the UI; switching files aborts cleanly.
 * The page is keep-alive: returning to Workspace preserves selection state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import 'monaco-editor/esm/vs/editor/editor.all.js';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

import type { FileDiffResult } from '../../../shared/changes';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Button, Spinner } from '../components/ui';
import { useChanges } from '../changes/changes-store';
import { badgeTitle, changedFiles } from '../changes/model';
import {
  SYNC_LOAD_LIMIT,
  applyTextInChunks,
  createHunkNav,
  moveHunk
} from '../diff/logic';
import { useApp } from '../store/app-store';

/* ------------------------------------------------------------------ */
/* Monaco bootstrap                                                     */
/* ------------------------------------------------------------------ */

self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  }
};

monaco.editor.defineTheme('dsh-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6a737d' }
  ],
  colors: {
    'editor.background': '#ffffff',
    'editorGutter.background': '#f6f8fa',
    'diffEditor.insertedTextBackground': '#22863a1f',
    'diffEditor.insertedLineBackground': '#22863a14',
    'diffEditor.removedTextBackground': '#cb24311f',
    'diffEditor.removedLineBackground': '#cb243114'
  }
});

monaco.editor.setTheme('dsh-light');

const MONACO_OPTIONS: monaco.editor.IDiffEditorConstructionOptions = {
  readOnly: true,
  renderSideBySide: false, // unified view (§5)
  originalEditable: false,
  automaticLayout: true, // survives the keep-alive hidden ⇄ visible toggle
  fontFamily: "'Cascadia Code', 'Fira Code', Menlo, Consolas, 'Courier New', monospace",
  fontSize: 13,
  lineNumbersMinChars: 4,
  glyphMargin: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: 'off', // long lines scroll horizontally (§5)
  diffWordWrap: 'off',
  renderOverviewRuler: false,
  hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 0 },
  scrollbar: { alwaysConsumeMouseWheel: false }
};

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/** Append text to a model in bounded chunks, yielding between them. */
async function streamInto(
  model: monaco.editor.ITextModel,
  text: string,
  onProgress: (percent: number) => void,
  isCancelled: () => boolean
): Promise<void> {
  if (text.length <= SYNC_LOAD_LIMIT) {
    model.setValue(text);
    onProgress(100);
    return;
  }
  await applyTextInChunks(
    text,
    (slice) => {
      if (isCancelled()) throw new Error('diff-load-cancelled');
      const lastLine = model.getLineCount();
      const lastCol = model.getLineMaxColumn(lastLine);
      model.applyEdits([
        { range: new monaco.Range(lastLine, lastCol, lastLine, lastCol), text: slice }
      ]);
    },
    {
      chunkSize: 256 * 1024,
      onProgress: (loaded, total) => onProgress(Math.min(99, Math.round((loaded / total) * 100)))
    }
  );
  onProgress(100);
}

type Phase = 'loading' | 'ready' | 'error';

/* ------------------------------------------------------------------ */
/* Single-file diff view                                                */
/* ------------------------------------------------------------------ */

function FileDiffView({ path, visible }: { path: string; visible: boolean }): JSX.Element {
  const changes = useChanges();
  const [phase, setPhase] = useState<Phase>('loading');
  const [result, setResult] = useState<FileDiffResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [revertBusy, setRevertBusy] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const hunksRef = useRef<monaco.editor.ILineChange[]>([]);
  const cancelledRef = useRef(false);
  const [nav, setNav] = useState(createHunkNav(0));
  const navRef = useRef(nav);
  navRef.current = nav;

  /* ---- fetch diff ---- */
  useEffect(() => {
    let alive = true;
    setPhase('loading');
    setResult(null);
    setErrorMessage(null);
    setProgress(0);
    window.desktop
      .getFileDiff(path)
      .then((r) => {
        if (!alive) return;
        if (r.ok) {
          setResult(r);
          setPhase('ready');
        } else {
          setErrorMessage(r.error ?? '无法读取文件差异');
          setPhase('error');
        }
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setPhase('error');
      });
    return () => {
      alive = false;
    };
  }, [path]);

  /* ---- create the editor once ---- */
  useEffect(() => {
    const host = hostRef.current;
    if (host == null) return;
    cancelledRef.current = false;
    const editor = monaco.editor.createDiffEditor(host, MONACO_OPTIONS);
    editorRef.current = editor;
    return () => {
      cancelledRef.current = true;
      const models = editor.getModel();
      models?.original.dispose();
      models?.modified.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  /* ---- fill models when the diff result arrives ---- */
  useEffect(() => {
    if (phase !== 'ready' || result == null || result.binary === true) return;
    const editor = editorRef.current;
    if (editor == null) return;

    const original = monaco.editor.createModel(result.original ?? '', 'plaintext');
    const modified = monaco.editor.createModel(result.modified ?? '', 'plaintext');
    editor.setModel({ original, modified });

    let cancelled = false;
    void (async () => {
      try {
        setProgress(10);
        await streamInto(original, result.original ?? '', (p) => setProgress(Math.max(10, p / 2)), () => cancelled);
        if (cancelled) return;
        await streamInto(modified, result.modified ?? '', (p) => setProgress(50 + p / 2), () => cancelled);
        if (cancelled) return;
        // Hunk list is only trustworthy once both models are fully loaded.
        hunksRef.current = editor.getLineChanges() ?? [];
        setNav(createHunkNav(hunksRef.current.length));
        setProgress(100);
      } catch {
        /* cancelled by unmount or file switch */
      }
    })();

    return () => {
      cancelled = true;
      original.dispose();
      modified.dispose();
      hunksRef.current = [];
      setNav(createHunkNav(0));
    };
  }, [phase, result]);

  /* ---- hunk navigation ---- */
  const goTo = useCallback((delta: 1 | -1) => {
    const editor = editorRef.current;
    if (editor == null) return;
    const next = moveHunk(navRef.current, delta);
    setNav(next);
    const change = hunksRef.current[next.index];
    if (change == null) return;
    const modifiedEditor = editor.getModifiedEditor();
    const originalEditor = editor.getOriginalEditor();

    const newStart = Math.max(change.modifiedStartLineNumber, 1);
    const oldStart = Math.max(change.originalStartLineNumber, 1);
    modifiedEditor.revealLineInCenter(newStart);
    modifiedEditor.setPosition({ lineNumber: newStart, column: 1 });

    // Emphasis beyond color: select the hunk lines (add/remove not color-only §5).
    const modifiedModel = modifiedEditor.getModel();
    if (change.modifiedEndLineNumber > change.modifiedStartLineNumber && modifiedModel != null) {
      const end = change.modifiedEndLineNumber;
      modifiedEditor.setSelection(
        new monaco.Range(newStart, 1, end, modifiedModel.getLineMaxColumn(end))
      );
    } else {
      const originalModel = originalEditor.getModel();
      originalEditor.revealLineInCenter(oldStart);
      if (
        change.originalEndLineNumber > change.originalStartLineNumber &&
        originalModel != null
      ) {
        const end = change.originalEndLineNumber;
        originalEditor.setSelection(
          new monaco.Range(oldStart, 1, end, originalModel.getLineMaxColumn(end))
        );
      }
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        goTo(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        goTo(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, goTo]);

  /* ---- revert with double confirmation ---- */
  const doRevert = useCallback(async () => {
    setRevertBusy(true);
    try {
      await changes.revert(path);
    } finally {
      setRevertBusy(false);
      setConfirmOpen(false);
    }
  }, [changes, path]);

  const revertFeedback = useMemo(() => {
    if (changes.lastRevert == null || changes.lastRevert.path !== path) return null;
    const r = changes.lastRevert;
    if (!r.ok) return null;
    if (r.noop) return { tone: 'info' as const, text: '该文件没有需要恢复的改动（已是目标状态）。' };
    if (r.residual)
      return {
        tone: 'warn' as const,
        text: '工作区内容已恢复，但索引中仍有暂存改动；该文件保留在变更列表中以便继续处理。'
      };
    return { tone: 'ok' as const, text: '已恢复到 HEAD 版本。' };
  }, [changes.lastRevert, path]);

  /* ---- render ---- */

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <code className="diff-path" title={path}>
          {path}
        </code>
        <div className="diff-actions">
          <Button
            size="sm"
            variant="secondary"
            disabled={!nav.hasPrev}
            onClick={() => goTo(-1)}
            title="上一个 hunk（Alt+↑）"
          >
            ↑ 上一个
          </Button>
          <span className="hunk-pos" aria-live="polite">
            {nav.count > 0 ? `${nav.index + 1}/${nav.count} 处改动` : '无改动块'}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={!nav.hasNext}
            onClick={() => goTo(1)}
            title="下一个 hunk（Alt+↓）"
          >
            ↓ 下一个
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => setConfirmOpen(true)}
            disabled={revertBusy || phase !== 'ready'}
            title="将该文件恢复到 HEAD 版本（不可撤销，需二次确认）"
          >
            恢复此文件…
          </Button>
        </div>
      </div>

      {revertFeedback != null && (
        <p className={`feedback feedback-${revertFeedback.tone}`} role="status">
          {revertFeedback.text}
        </p>
      )}
      {changes.revertError !== null && (
        <p className="feedback feedback-error" role="alert">
          恢复失败：{changes.revertError}
        </p>
      )}
      {result?.truncated === true && (
        <p className="feedback feedback-warn">
          文件过大，差异内容被截断显示（上限 16MB）；完整差异请使用 Git 命令查看。
        </p>
      )}

      {phase === 'loading' && (
        <div className="diff-status">
          <Spinner label="加载差异" /> 正在读取差异…
        </div>
      )}
      {phase === 'error' && (
        <div className="diff-status diff-error-card" role="alert">
          无法显示该文件的差异：{errorMessage}
          <span className="hint">（文件可能不存在于当前工作区，或不是可读的文本文件）</span>
        </div>
      )}
      {phase === 'ready' && result?.binary === true && (
        <div className="diff-status">
          二进制文件不展示文本差异。仍可使用「恢复此文件」将其回退到 HEAD 版本。
        </div>
      )}

      <div ref={hostRef} className="diff-monaco-host" aria-label={`Unified diff：${path}`} />
      {progress > 0 && progress < 100 && phase === 'ready' && (
        <div className="diff-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
          <div className="diff-progress-bar" style={{ width: `${progress}%` }} />
          <span className="hint">大文件分片加载中 {progress}%</span>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        busy={revertBusy}
        title="恢复文件到 HEAD 版本"
        stage2Label="继续"
        confirmLabel="确认丢弃我的修改"
        warning="此操作会永久丢弃该文件的未提交修改，且不可撤销。"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void doRevert()}
      >
        <p>
          将把 <code>{path}</code> 恢复为 Git HEAD 中的内容：
        </p>
        <ul className="confirm-list">
          <li>未提交的修改会被覆盖或删除（新增文件将被移除）；</li>
          <li>不会执行任何 Git 写命令（不 commit、不 checkout、不 restore）；</li>
          <li>若暂存区仍有残留改动，该条目会保留在变更列表中提示处理。</li>
        </ul>
      </ConfirmDialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export default function DiffPage(): JSX.Element {
  const { state: appState, dispatch } = useApp();
  const changes = useChanges();
  const files = changedFiles(changes.snapshot);
  const visible = appState.route === 'diff';
  const branchLabel = changes.snapshot?.gitAvailable
    ? `⎇ ${changes.snapshot.branch ?? '未知分支'}${changes.snapshot.detached ? ' (detached)' : ''}`
    : null;

  return (
    <div className="page page-diff">
      <header className="diff-head">
        <h2 className="section-title">Diff Viewer</h2>
        {branchLabel != null && (
          <span className={`branch-pill${changes.snapshot?.detached ? ' branch-detached' : ''}`}>
            {branchLabel}
          </span>
        )}
        <span className="hint">
          当前 Workspace：<code>{appState.workspaceRoot ?? '未打开项目'}</code>
        </span>
        <Button size="sm" variant="secondary" onClick={() => dispatch({ type: 'navigate', route: 'workspace' })}>
          返回 Workspace
        </Button>
      </header>

      {files.length === 0 ? (
        <section className="diff-empty" aria-label="暂无文件变更">
          <p className="empty-hint">暂无文件变更。运行任务产生 file_changed 事件后，这里会列出可查看的 Unified Diff。</p>
          <Button variant="primary" onClick={() => dispatch({ type: 'navigate', route: 'workspace' })}>
            返回 Workspace
          </Button>
          <p className="hint">页面常驻：返回后已选文件与滚动位置都会保留。</p>
        </section>
      ) : (
        <div className="diff-layout">
          <aside className="col diff-files" aria-label="Changed Files">
            <h3 className="panel-title">Changed Files（{files.length}）</h3>
            <ul className="changes-list">
              {files.map((c) => {
                const selected = c.path === changes.selectedPath;
                return (
                  <li key={`${c.source}:${c.path}`} className="change-row">
                    <button
                      type="button"
                      className={`change change-btn change-${c.kind}${selected ? ' change-selected' : ''}`}
                      onClick={() => changes.select(c.path)}
                      aria-current={selected ? 'true' : undefined}
                      title={`${badgeTitle(c.kind)} · ${c.path}`}
                    >
                      <span className={`change-kind kind-${c.kind}`} role="img" aria-label={badgeTitle(c.kind)}>
                        {c.kind === 'added' ? 'A' : c.kind === 'deleted' ? 'D' : 'M'}
                      </span>
                      <code className="change-path">{c.path}</code>
                      <span className="change-src">{c.source === 'git' ? 'Git' : '事件'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
          <section className="col diff-main">
            {changes.selectedPath == null ? (
              <div className="diff-empty">
                <p className="empty-hint">从左侧选择一个文件以查看 Unified Diff。</p>
              </div>
            ) : (
              <FileDiffView key={changes.selectedPath} path={changes.selectedPath} visible={visible} />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
