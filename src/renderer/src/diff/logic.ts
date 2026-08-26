/**
 * Pure diff-view logic (issue DSHA-6): unified diff parsing, hunk navigation
 * with hard disabled ends (issue wording supersedes AC-09 wrap-around) and a
 * chunked lazy loader that keeps multi-megabyte diffs from freezing the UI.
 *
 * No React/DOM/Monaco imports — everything here is unit-testable in node.
 */

/* ------------------------------------------------------------------ */
/* Unified diff parsing                                                */
/* ------------------------------------------------------------------ */

export interface ParsedHunk {
  /** 1-based line numbers from the @@ header. */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw `@@ … @@` header text. */
  header: string;
  /** Body lines including their +/-/' ' prefixes ('\ No newline' kept). */
  lines: string[];
}

export interface ParsedDiff {
  /** File-level git header lines (diff --git/index/---/+++ …). */
  fileHeader: string[];
  hunks: ParsedHunk[];
}

/**
 * Tolerant unified-diff parser: accepts git-style diffs (with headers),
 * bare patches and synthesized add-only diffs. Never throws on odd input —
 * worst case it returns zero hunks.
 */
export function parseUnifiedDiff(text: string | null | undefined): ParsedDiff {
  const result: ParsedDiff = { fileHeader: [], hunks: [] };
  if (!text) return result;
  const lines = text.split('\n');
  // A trailing split artifact (text ending with \n) yields a final ''.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let current: ParsedHunk | null = null;
  let seenHunkHeader = false;
  for (const line of lines) {
    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkMatch) {
      current = {
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] != null ? Number(hunkMatch[2]) : 1,
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] != null ? Number(hunkMatch[4]) : 1,
        header: line,
        lines: []
      };
      result.hunks.push(current);
      seenHunkHeader = true;
      continue;
    }
    if (!seenHunkHeader) {
      result.fileHeader.push(line);
      continue;
    }
    if (current == null) continue;
    if (
      line.startsWith('+') ||
      line.startsWith('-') ||
      line.startsWith(' ') ||
      line.startsWith('\\')
    ) {
      current.lines.push(line);
    } else if (line.trim() === '') {
      current.lines.push(' '); // empty context line lost its leading space
    } else {
      // Unknown marker inside hunk body — stop trusting this hunk.
      break;
    }
  }
  return result;
}

/** Added/removed line counts derived from hunk bodies (+/- prefixes). */
export function diffStats(parsed: ParsedDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of parsed.hunks) {
    for (const l of h.lines) {
      if (l.startsWith('+')) added += 1;
      else if (l.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}

/* ------------------------------------------------------------------ */
/* Hunk navigation                                                     */
/* ------------------------------------------------------------------ */

export interface HunkNavState {
  index: number;
  count: number;
  hasPrev: boolean;
  hasNext: boolean;
}

/** Initial navigation state: first hunk selected (or none when empty). */
export function createHunkNav(count: number): HunkNavState {
  return {
    index: count > 0 ? 0 : -1,
    count,
    hasPrev: false, // at first ⇒ prev disabled
    hasNext: count > 1
  };
}

function clamp(state: HunkNavState, index: number): HunkNavState {
  const i = Math.max(0, Math.min(index, state.count - 1));
  return {
    index: i,
    count: state.count,
    hasPrev: i > 0,
    hasNext: i < state.count - 1
  };
}

/**
 * Move by delta WITHOUT wrapping — issue DSHA-6 explicitly requires disabled
 * Prev/Next at the first/last hunk (supersedes AC-09's 循环定位 wording).
 */
export function moveHunk(state: HunkNavState, delta: 1 | -1): HunkNavState {
  if (state.count <= 0 || state.index < 0) return state;
  return clamp(state, state.index + delta);
}

/* ------------------------------------------------------------------ */
/* Chunked lazy loading                                                */
/* ------------------------------------------------------------------ */

export interface ChunkedLoadOptions {
  /** Characters per applied chunk (default 256k). */
  chunkSize?: number;
  /** Abort support so switching files mid-load cancels cleanly. */
  signal?: AbortSignal;
  /** Progress callback (monotonic loaded char count). */
  onProgress?: (loadedChars: number, totalChars: number) => void;
  /**
   * Yield between chunks — injectable for tests; defaults to a macrotask
   * setTimeout so the renderer paints between edits.
   */
  yieldFn?: () => Promise<void>;
}

export interface ChunkedLoadResult {
  appliedChunks: number;
  totalChunks: number;
  appliedChars: number;
  cancelled: boolean;
}

const DEFAULT_CHUNK_SIZE = 256 * 1024;

const defaultYield = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Apply `text` to an appendable sink in bounded chunks, yielding between
 * them so big diffs never block the event loop (perf case: ≥5MB diff).
 *
 * The sink receives successive slices; the caller owns how they land
 * (e.g. monaco model.applyEdits at the end offset).
 */
export async function applyTextInChunks(
  text: string,
  appendChunk: (slice: string, startOffset: number) => void,
  options: ChunkedLoadOptions = {}
): Promise<ChunkedLoadResult> {
  const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const yieldFn = options.yieldFn ?? defaultYield;
  const total = text.length;
  if (total === 0) {
    options.onProgress?.(0, 0);
    return { appliedChunks: 0, totalChunks: 0, appliedChars: 0, cancelled: false };
  }
  const totalChunks = Math.ceil(total / chunkSize);
  let offset = 0;
  let appliedChunks = 0;
  while (offset < total) {
    if (options.signal?.aborted) {
      return { appliedChunks, totalChunks, appliedChars: offset, cancelled: true };
    }
    const end = Math.min(offset + chunkSize, total);
    appendChunk(text.slice(offset, end), offset);
    appliedChunks += 1;
    offset = end;
    options.onProgress?.(offset, total);
    if (offset < total) await yieldFn();
  }
  return { appliedChunks, totalChunks, appliedChars: offset, cancelled: false };
}

/** Threshold under which content loads synchronously (single chunk). */
export const SYNC_LOAD_LIMIT = 1024 * 1024;

export function needsChunkedLoading(textLength: number, threshold: number = SYNC_LOAD_LIMIT): boolean {
  return textLength > threshold;
}
