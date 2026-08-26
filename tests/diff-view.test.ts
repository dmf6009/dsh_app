/**
 * Diff view pure-logic tests (DSHA-6): unified parsing, hunk navigation
 * disabled ends (issue wording supersedes AC-09 wrap-around), and the
 * chunked lazy loader with a ≥5MB perf case.
 */

import { describe, expect, it } from 'vitest';

import {
  applyTextInChunks,
  createHunkNav,
  diffStats,
  moveHunk,
  needsChunkedLoading,
  parseUnifiedDiff
} from '../src/renderer/src/diff/logic';

const SAMPLE = [
  'diff --git a/app.py b/app.py',
  'index 111..222 100644',
  '--- a/app.py',
  '+++ b/app.py',
  '@@ -1,4 +1,5 @@',
  ' context',
  '-old line',
  '+new line',
  '+added line',
  ' more context',
  '@@ -20,3 +21,4 @@',
  ' ctx2',
  '-gone',
  '+back'
].join('\n');

describe('parseUnifiedDiff', () => {
  it('extracts hunks with headers, ranges and bodies', () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    expect(parsed.fileHeader).toHaveLength(4);
    expect(parsed.hunks).toHaveLength(2);

    const [h1, h2] = parsed.hunks;
    expect(h1!.oldStart).toBe(1);
    expect(h1!.newStart).toBe(1);
    expect(h1!.lines).toEqual([' context', '-old line', '+new line', '+added line', ' more context']);
    expect(h2!.header).toContain('@@ -20,3 +21,4 @@');
  });

  it('handles single-line range shorthand (@@ -3 +3 @@)', () => {
    const parsed = parseUnifiedDiff('@@ -3 +3 @@\n-a\n+b');
    expect(parsed.hunks[0]).toMatchObject({ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 });
  });

  it('never throws on empty or garbage input', () => {
    expect(parseUnifiedDiff('').hunks).toHaveLength(0);
    expect(parseUnifiedDiff(null as unknown as string).hunks).toHaveLength(0);
    expect(parseUnifiedDiff('not a diff at all').hunks).toHaveLength(0);
  });

  it('counts added/removed lines for badges', () => {
    expect(diffStats(parseUnifiedDiff(SAMPLE))).toEqual({ added: 3, removed: 2 });
  });

  it('keeps "\ No newline at end of file" markers inside hunks', () => {
    const parsed = parseUnifiedDiff('@@ -1 +1 @@\n-old\\n no nl\n+new\n\\ No newline at end of file');
    // Marker attaches to the new side; parser must not choke on it.
    expect(parsed.hunks[0]!.lines.some((l) => l.startsWith('\\'))).toBe(true);
  });
});

describe('hunk navigation', () => {
  it('starts at the first hunk with prev disabled', () => {
    const nav = createHunkNav(3);
    expect(nav.index).toBe(0);
    expect(nav.hasPrev).toBe(false);
    expect(nav.hasNext).toBe(true);
  });

  it('disables next at the last hunk — NO wrap-around (issue override)', () => {
    let nav = createHunkNav(2);
    nav = moveHunk(nav, 1);
    expect(nav.index).toBe(1);
    expect(nav.hasNext).toBe(false); // disabled, not wrapped to 0
    expect(moveHunk(nav, 1)).toEqual(nav); // further next is a no-op
    nav = moveHunk(nav, -1);
    expect(nav.index).toBe(0);
    expect(nav.hasPrev).toBe(false); // first again → prev disabled
  });

  it('single-hunk diffs disable both buttons', () => {
    const nav = createHunkNav(1);
    expect(nav.hasPrev).toBe(false);
    expect(nav.hasNext).toBe(false);
    expect(moveHunk(nav, 1)).toEqual(nav);
    expect(moveHunk(nav, -1)).toEqual(nav);
  });

  it('empty hunk lists park navigation at -1 with everything disabled', () => {
    const nav = createHunkNav(0);
    expect(nav.index).toBe(-1);
    expect(nav.hasPrev).toBe(false);
    expect(nav.hasNext).toBe(false);
    expect(moveHunk(nav, 1)).toEqual(nav);
  });

  it('walks forward through every hunk in order', () => {
    let nav = createHunkNav(4);
    const seen: number[] = [nav.index];
    while (nav.hasNext) {
      nav = moveHunk(nav, 1);
      seen.push(nav.index);
    }
    expect(seen).toEqual([0, 1, 2, 3]);
  });
});

describe('chunked lazy loader', () => {
  it('applies small text in one chunk synchronously', async () => {
    const appended: string[] = [];
    const res = await applyTextInChunks('hello', (slice) => appended.push(slice));
    expect(res.totalChunks).toBe(1);
    expect(appended).toEqual(['hello']);
    expect(res.appliedChars).toBe(5);
    expect(res.cancelled).toBe(false);
  });

  it('splits large text into bounded chunks and preserves content', async () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line-${i}`).join('\n');
    const chunks: Array<{ slice: string; offset: number }> = [];
    const res = await applyTextInChunks(
      text,
      (slice, offset) => chunks.push({ slice, offset }),
      { chunkSize: 512, yieldFn: async () => undefined }
    );
    expect(chunks.every((c) => c.slice.length <= 512)).toBe(true);
    expect(res.appliedChars).toBe(text.length);
    expect(chunks.map((c) => c.slice).join('')).toBe(text);
    // Offsets are contiguous.
    expect(chunks[0]!.offset).toBe(0);
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]!.offset).toBe(chunks[i - 1]!.offset + chunks[i - 1]!.slice.length);
    }
  });

  it('reports monotonic progress across chunks', async () => {
    const text = 'x'.repeat(5000);
    const progress: number[] = [];
    await applyTextInChunks(text, () => undefined, {
      chunkSize: 1000,
      yieldFn: async () => undefined,
      onProgress: (loaded) => progress.push(loaded)
    });
    expect(progress.length).toBeGreaterThan(3);
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    }
    expect(progress.at(-1)).toBe(5000);
  });

  it('yields between chunks so the event loop stays responsive', async () => {
    let yields = 0;
    await applyTextInChunks('y'.repeat(4000), () => undefined, {
      chunkSize: 1000,
      yieldFn: async () => {
        yields += 1;
      }
    });
    expect(yields).toBe(3); // between 4 chunks — never after the last one
  });

  it('PERF CASE: a 5MB+ diff loads in bounded slices without blocking', async () => {
    // ~5.5MB of realistic diff-ish content.
    const unit = '-removed context line with some text\n+added replacement line here\n';
    const repeats = Math.ceil((5 * 1024 * 1024) / unit.length);
    const bigDiff = unit.repeat(repeats);
    expect(bigDiff.length).toBeGreaterThan(5 * 1024 * 1024);

    const t0 = Date.now();
    const seen: number[] = [];
    const res = await applyTextInChunks(bigDiff, () => undefined, {
      chunkSize: 256 * 1024,
      yieldFn: async () => undefined,
      onProgress: (loaded) => {
        if (seen.length === 0 || loaded - seen[seen.length - 1]! >= 256 * 1024) {
          seen.push(loaded);
        }
      }
    });
    const elapsed = Date.now() - t0;

    expect(res.cancelled).toBe(false);
    expect(res.appliedChars).toBe(bigDiff.length);
    expect(seen[0]).toBeLessThanOrEqual(256 * 1024); // first slice is bounded
    // Sanity bound: chunked application completes quickly when yields are
    // cheap; the real protection is that each append is ≤256k chars.
    expect(elapsed).toBeLessThan(10_000);
  });

  it('abort cancels mid-stream with partial progress', async () => {
    const controller = new AbortController();
    let appends = 0;
    const res = await applyTextInChunks(
      'z'.repeat(10_000),
      () => {
        appends += 1;
        if (appends === 2) controller.abort();
      },
      { chunkSize: 1000, signal: controller.signal, yieldFn: async () => undefined }
    );
    expect(res.cancelled).toBe(true);
    expect(appends).toBe(2);
    expect(res.appliedChars).toBe(2000);
  });

  it('flags when content exceeds the sync threshold', () => {
    expect(needsChunkedLoading(100)).toBe(false);
    expect(needsChunkedLoading(5 * 1024 * 1024)).toBe(true);
  });
});
