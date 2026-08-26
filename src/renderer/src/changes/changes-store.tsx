/**
 * React bindings for the aggregated Changes state (issue DSHA-6).
 *
 * The provider subscribes to the main-process snapshot push (which already
 * merges runtime file_changed events with the read-only git view) and owns
 * the destructive revert call — components never invoke IPC directly.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode
} from 'react';

import type { RevertFileResult } from '../../../shared/changes';
import { initialChangesState, reduceChanges, type ChangesAction, type ChangesState } from './model';

export interface ChangesStoreValue extends ChangesState {
  select: (path: string | null) => void;
  revert: (path: string) => Promise<void>;
}

const ChangesContext = createContext<ChangesStoreValue | null>(null);

export function ChangesProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(
    (s: ChangesState, a: ChangesAction) => reduceChanges(s, a),
    initialChangesState
  );

  useEffect(() => {
    const off = window.desktop.onChangesSnapshot((snapshot) => {
      dispatch({ type: 'snapshot', snapshot });
    });
    void window.desktop
      .getChangesSnapshot()
      .then((snapshot) => dispatch({ type: 'snapshot', snapshot }))
      .catch(() => undefined);
    return off;
  }, []);

  // Auto-expire the post-revert flash so rows return to normal styling.
  useEffect(() => {
    if (state.lastRevert == null) return;
    const t = setTimeout(() => dispatch({ type: 'revert-feedback-expired' }), 4000);
    return () => clearTimeout(t);
  }, [state.lastRevert]);

  const select = useCallback((path: string | null) => {
    dispatch({ type: 'select', path });
  }, []);

  const revert = useCallback(async (path: string) => {
    try {
      const { result }: { result: RevertFileResult } = await window.desktop.revertFile(path);
      dispatch({ type: 'revert-result', path, result });
    } catch (err) {
      dispatch({
        type: 'revert-error',
        path,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }, []);

  const value = useMemo<ChangesStoreValue>(
    () => ({ ...state, select, revert }),
    [state, select, revert]
  );

  return <ChangesContext.Provider value={value}>{children}</ChangesContext.Provider>;
}

export function useChanges(): ChangesStoreValue {
  const ctx = useContext(ChangesContext);
  if (!ctx) throw new Error('useChanges 必须在 <ChangesProvider> 内使用');
  return ctx;
}
