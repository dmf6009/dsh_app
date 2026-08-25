/**
 * Diff Viewer page — P1-A only delivers the routed skeleton so Workspace ⇄
 * Diff navigation preserves state; real diff rendering is a later stage.
 */

import { Badge, Button } from '../components/ui';
import { useApp } from '../store/app-store';

const SAMPLE_FILES: ReadonlyArray<{ path: string; add: number; del: number }> = [
  { path: 'src/api/login.ts', add: 12, del: 3 },
  { path: 'src/utils/token.ts', add: 5, del: 5 }
];

export default function DiffPage(): JSX.Element {
  const { state, dispatch } = useApp();

  return (
    <div className="page page-diff">
      <header className="diff-head">
        <h2 className="section-title">Diff Viewer</h2>
        <span className="hint">
          当前 Workspace：<code>{state.workspaceRoot ?? '未打开项目'}</code>
        </span>
        <Button size="sm" variant="secondary" onClick={() => dispatch({ type: 'navigate', route: 'workspace' })}>
          返回 Workspace
        </Button>
      </header>

      <p className="empty-hint">Diff 渲染属于后续阶段；此处仅验证页面骨架与状态保持。</p>

      <section className="diff-files" aria-label="Changed files（示例数据）">
        <h3 className="panel-title">Changed Files</h3>
        <ul className="diff-list">
          {SAMPLE_FILES.map((file) => (
            <li key={file.path} className="diff-row">
              <code>{file.path}</code>
              <span className="diff-stats">
                <Badge tone="success">+{file.add}</Badge> <Badge tone="danger">-{file.del}</Badge>
              </span>
            </li>
          ))}
        </ul>
        <p className="hint">以上为静态示例，非真实工作区数据。</p>
      </section>
    </div>
  );
}
