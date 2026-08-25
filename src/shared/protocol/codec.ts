/**
 * Runtime Protocol v1 — JSONL frame codec.
 *
 * The decoder faces untrusted input (whatever the child process writes to
 * stdout), so its contract is: never throw, never grow without bound, and
 * always keep decoding subsequent frames. Failures surface as data
 * (`invalid` / `oversizedLine` reports), not exceptions.
 *
 * - Malformed JSON  → reported via `invalid`, stream continues.
 * - Overlong lines  → tracked while buffering; once a line exceeds
 *   `maxLineBytes` the decoder drops bytes until the next newline, reports
 *   one `oversizedLine`, and continues with what follows. Buffered bytes are
 *   therefore bounded by maxLineBytes + largest single chunk.
 */

import { PROTOCOL_VERSION } from './types';

/** Default cap for a single protocol line: 8 MiB. */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface InvalidFrameInfo {
  /** Why the line was rejected. */
  reason: 'json_parse_error' | 'not_an_object' | 'bad_envelope' | 'line_too_long';
  detail?: string;
  /** First bytes of the offending line, for diagnostics only. */
  preview?: string;
}

export interface DecoderReport {
  invalid: InvalidFrameInfo[];
  oversizedLines: number;
}

export interface DecodeResult extends DecoderReport {
  frames: unknown[];
}

export interface FrameDecoderOptions {
  maxLineBytes?: number;
}

const NL = 0x0a; // '\n'
const CR = 0x0d; // '\r'

/** A line consisting only of spaces/tabs/CR counts as a blank separator. */
function isBlank(line: Buffer): boolean {
  for (const byte of line) {
    if (byte !== 0x20 && byte !== 0x09 && byte !== CR) return false;
  }
  return true;
}

export class FrameDecoder {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** While true, everything up to and including the next newline is dropped. */
  private discarding = false;
  private readonly maxLineBytes: number;

  constructor(options: FrameDecoderOptions = {}) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    if (!Number.isInteger(this.maxLineBytes) || this.maxLineBytes <= 0) {
      throw new RangeError(`maxLineBytes must be a positive integer, got ${this.maxLineBytes}`);
    }
  }

  get bufferedBytes(): number {
    return this.pendingBytes;
  }

  /** Feed one stdout chunk; returns every complete frame decoded from it. */
  push(chunk: Uint8Array): DecodeResult {
    const report = emptyReport();
    const frames: unknown[] = [];
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    let offset = 0;
    while (offset < buf.length) {
      const nl = buf.indexOf(NL, offset);
      const hasNewline = nl !== -1;

      if (this.discarding) {
        // Overflow mode: drop up to and including the next newline.
        if (!hasNewline) {
          offset = buf.length;
          break;
        }
        this.discarding = false;
        offset = nl + 1;
        continue;
      }

      if (!hasNewline) {
        this.append(buf.subarray(offset));
        if (this.pendingBytes > this.maxLineBytes) {
          this.enterOverflow(report);
        }
        break;
      }

      this.append(buf.subarray(offset, nl));
      offset = nl + 1;
      this.consumePendingLine(report, frames);
    }

    return { frames, ...report };
  }

  /**
   * Signal end-of-stream: any trailing bytes form one final line even though
   * it was not newline-terminated. Returns leftover decodable content.
   */
  flush(): DecodeResult {
    const report = emptyReport();
    const frames: unknown[] = [];
    if (!this.discarding && this.pendingBytes > 0) {
      this.consumePendingLine(report, frames);
    }
    this.reset();
    return { frames, ...report };
  }

  reset(): void {
    this.pending = [];
    this.pendingBytes = 0;
    this.discarding = false;
  }

  private append(part: Buffer): void {
    if (part.length === 0) return;
    this.pending.push(part);
    this.pendingBytes += part.length;
  }

  private enterOverflow(report: DecoderReport): void {
    report.invalid.push({
      reason: 'line_too_long',
      detail: `line exceeded maxLineBytes=${this.maxLineBytes}; dropping until next newline`
    });
    report.oversizedLines += 1;
    this.pending = [];
    this.pendingBytes = 0;
    this.discarding = true;
  }

  private consumePendingLine(report: DecoderReport, frames: unknown[]): void {
    let line =
      this.pending.length === 1 ? this.pending[0]! : Buffer.concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;

    if (line.length > 0 && line[line.length - 1] === CR) {
      line = line.subarray(0, line.length - 1);
    }
    if (line.length > this.maxLineBytes) {
      report.invalid.push({
        reason: 'line_too_long',
        detail: `line of ${line.length} bytes exceeded maxLineBytes=${this.maxLineBytes}`
      });
      report.oversizedLines += 1;
      return;
    }
    if (isBlank(line)) return; // tolerate blank separator lines

    this.decodeLine(line, report, frames);
  }

  private decodeLine(line: Buffer, report: DecoderReport, frames: unknown[]): void {
    let parsed: unknown;
    const text = line.toString('utf8');
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      report.invalid.push({
        reason: 'json_parse_error',
        detail: err instanceof Error ? err.message : String(err),
        preview: text.slice(0, 200)
      });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      report.invalid.push({
        reason: 'not_an_object',
        detail: 'frame must be a JSON object',
        preview: text.slice(0, 200)
      });
      return;
    }
    const envelope = parsed as Record<string, unknown>;
    if (envelope['v'] !== PROTOCOL_VERSION || typeof envelope['type'] !== 'string') {
      report.invalid.push({
        reason: 'bad_envelope',
        detail: 'frame requires numeric "v" and string "type"',
        preview: text.slice(0, 200)
      });
      return;
    }
    frames.push(parsed);
  }
}

export interface FrameDecoderStats {
  bufferedBytes: number;
  discarding: boolean;
}

/* ------------------------------------------------------------------ */

/**
 * Encode an outbound frame into one JSONL line. Unlike the decoder, the
 * encoder faces programmer error, so violations fail fast and loudly.
 */
export function encodeFrame(frame: { v: unknown; type: unknown }): string {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    throw new TypeError('protocol frame must be a non-null object');
  }
  if (frame.v !== PROTOCOL_VERSION) {
    throw new TypeError(`protocol frame must carry v=${PROTOCOL_VERSION}`);
  }
  if (typeof frame.type !== 'string' || frame.type.length === 0) {
    throw new TypeError('protocol frame must carry a non-empty string "type"');
  }
  return `${JSON.stringify(frame)}\n`;
}

function emptyReport(): DecoderReport {
  return { invalid: [], oversizedLines: 0 };
}
