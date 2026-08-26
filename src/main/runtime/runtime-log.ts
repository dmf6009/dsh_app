/**
 * Runtime Logs — persisted, mandatorily redacted operational log (§33).
 *
 * Everything the Desktop records about the runtime conversation — raw stdout,
 * stderr, decoded events, tool activity, model request metadata — flows
 * through `append()`, the single choke point that applies two redaction
 * layers before storage:
 *
 *   1. explicit secrets registered by the settings store;
 *   2. credential-shaped patterns (sk-… keys, Bearer tokens, api_key=…,
 *      Authorization headers, AWS access-key ids).
 *
 * Nothing can bypass the choke point, so even forgotten call sites cannot
 * leak an API key into Runtime Logs. Redacted content lands in a bounded
 * in-memory ring (for the UI) and an append-only file under
 * `<home>/.dsh/desktop/logs/` (for later inspection).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { redactSecrets } from '../settings/settings-store';
import type { RuntimeEventFrame } from '../../shared/protocol/types';

export type RuntimeLogCategory = 'stdout' | 'stderr' | 'event' | 'tool' | 'model';

/** Credential-shaped patterns scrubbed even without a registered secret. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(?<![A-Za-z0-9])(api[_-]?key|apikey|access[_-]?token|token|secret|password|passwd|pwd)\s*[=:]\s*("[^"\n]*"|'[^'\n]*'|[^\s,;&"']+)/gi,
  /\bauthorization\s*:\s*\S+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g
];

export const REDACTED = '[redacted]';

/**
 * Scrub credential-looking material from arbitrary text. Pure function so
 * the log-scan test can run against synthetic payloads.
 */
export function redactSensitive(text: string, extraSecrets: Iterable<string> = []): string {
  let out = redactSecrets(text, extraSecrets);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Render one protocol event into log lines (already goes through redaction). */
export function formatEventForLog(frame: RuntimeEventFrame): string {
  return JSON.stringify(frame);
}

export interface RuntimeLogEntry {
  at: number;
  category: RuntimeLogCategory;
  text: string;
}

export interface RuntimeLogStoreOptions {
  /** Home directory; logs go to `<home>/.dsh/desktop/logs`. */
  home?: string;
  now?: () => number;
  /** In-memory ring budget across all categories (bytes). */
  maxMemoryBytes?: number;
  /** Disable the file sink (tests); memory ring still applies. */
  fileSink?: boolean;
}

const DEFAULT_MEMORY_BUDGET = 256 * 1024;

export class RuntimeLogStore {
  private readonly entries: RuntimeLogEntry[] = [];
  private memoryBytes = 0;
  private readonly maxMemoryBytes: number;
  private readonly now: () => number;
  private readonly filePathValue: string | null;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly secretSource: () => string[] = () => [],
    options: RuntimeLogStoreOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.maxMemoryBytes = options.maxMemoryBytes ?? DEFAULT_MEMORY_BUDGET;
    if (options.fileSink === false || !options.home) {
      this.filePathValue = null;
      return;
    }
    const stamp = new Date(this.now())
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+$/, '');
    this.filePathValue = path.join(
      options.home,
      '.dsh',
      'desktop',
      'logs',
      `runtime-${stamp}-${process.pid}.log`
    );
  }

  /** Absolute path of the backing log file, or null when disabled. */
  get filePath(): string | null {
    return this.filePathValue;
  }

  /**
   * THE logging entry point. Text is redacted before it touches memory or
   * disk; there is intentionally no raw variant of this method.
   */
  append(category: RuntimeLogCategory, text: string): void {
    if (this.closed) return;
    const clean = redactSensitive(text, this.secretSource());
    this.pushMemory({ at: this.now(), category, text: clean });
    if (this.filePathValue !== null && clean.length > 0) {
      this.queueWrite(clean);
    }
  }

  appendEvent(frame: RuntimeEventFrame): void {
    this.append('event', formatEventForLog(frame));
  }

  /** Newest-first slice of the in-memory ring, optionally filtered. */
  tail(options: { category?: RuntimeLogCategory; maxChars?: number } = {}): string {
    let collected = '';
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i]!;
      if (options.category && entry.category !== options.category) continue;
      collected =
        `${new Date(entry.at).toISOString()} ${entry.category}: ${entry.text}\n` + collected;
      if (options.maxChars !== undefined && collected.length >= options.maxChars) break;
    }
    return collected.slice(-(options.maxChars ?? Number.POSITIVE_INFINITY));
  }

  get memoryUsage(): number {
    return this.memoryBytes;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeChain.catch(() => undefined);
  }

  /* ---------------------------------------------------------------- */

  private pushMemory(entry: RuntimeLogEntry): void {
    this.entries.push(entry);
    this.memoryBytes += entry.text.length;
    while (this.memoryBytes > this.maxMemoryBytes && this.entries.length > 1) {
      const dropped = this.entries.shift();
      if (dropped) this.memoryBytes -= dropped.text.length;
    }
  }

  private queueWrite(line: string): void {
    const target = this.filePathValue;
    if (target === null) return;
    const previous = this.writeChain;
    this.writeChain = previous
      .then(async () => {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.appendFile(target, `${line}\n`, 'utf8');
      })
      .catch(() => undefined); // logging must never take the app down
  }
}
