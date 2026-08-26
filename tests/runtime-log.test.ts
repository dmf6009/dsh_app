/**
 * Runtime Log tests (DSHA-5, §33): every category passes through mandatory
 * redaction — registered secrets AND credential-shaped patterns are filtered
 * before content reaches memory or disk. Also verifies the bounded ring.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { REDACTED, RuntimeLogStore, redactSensitive } from '../src/main/runtime/runtime-log';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined))
  );
});

async function makeTempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-logs-'));
  tempDirs.push(dir);
  return dir;
}

describe('redactSensitive — pattern scrubbing', () => {
  it('filters OpenAI-style sk- keys', () => {
    const out = redactSensitive('using key sk-proj-abcdefghij1234567890 done');
    expect(out).not.toContain('sk-proj-abcdefghij1234567890');
    expect(out).toContain(REDACTED);
    expect(out).toMatch(/^using key \[redacted\] done$/);
  });

  it('filters Bearer tokens case-insensitively', () => {
    const out = redactSensitive('authorization: Bearer abc.def.ghi-jkl_123');
    expect(out).not.toContain('abc.def.ghi-jkl_123');
    expect(out).toContain(REDACTED);
    const out2 = redactSensitive('"Authorization":"Bearer verylongtoken123456"');
    expect(out2.toLowerCase()).not.toContain('verylongtoken');
  });

  it('filters api_key / token / password assignments in any spelling', () => {
    for (const line of [
      'api_key=supersecretvalue123',
      'API-Key: supersecretvalue123',
      "api_key: 'supersecretvalue123'",
      'access_token="supersecretvalue123"',
      'password: hunter2',
      'client_secret=abcd1234wxyz'
    ]) {
      const out = redactSensitive(line);
      expect(out).not.toContain('supersecretvalue123');
      expect(out).not.toContain('hunter2');
      expect(out).not.toContain('abcd1234wxyz');
      expect(out).toContain(REDACTED);
    }
  });

  it('filters AWS access key ids', () => {
    const out = redactSensitive('AKIAIOSFODNN7EXAMPLE');
    expect(out).toBe(REDACTED);
  });

  it('applies registered secrets on top of patterns', () => {
    const out = redactSensitive('token is my-custom-org-secret-42 end', ['my-custom-org-secret-42']);
    expect(out).toBe('token is [redacted] end');
  });

  it('leaves harmless log text untouched', () => {
    const text = '12 passed, 2 skipped in 0.32s; file src/auth/login.py changed';
    expect(redactSensitive(text)).toBe(text);
  });
});

describe('RuntimeLogStore', () => {
  it('never stores or writes raw credentials through append()', async () => {
    const home = await makeTempHome();
    const store = new RuntimeLogStore(() => [], { home });
    try {
      store.append('stdout', 'request sent with api_key=sk-live-abcd12345678');
      store.append('stderr', 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');

      const tail = store.tail();
      expect(tail).not.toContain('sk-live-abcd12345678');
      expect(tail).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(tail).toContain(REDACTED);

      await store.close();
      const file = store.filePath;
      expect(file).toBeTruthy();
      const written = await fs.readFile(file!, 'utf8');
      expect(written).not.toContain('sk-live-abcd12345678');
      expect(written).toContain(REDACTED);
    } finally {
      await store.close();
    }
  });

  it('applies settings-registered secrets to the file sink too', async () => {
    const home = await makeTempHome();
    const store = new RuntimeLogStore(() => ['my-registered-key-xyz'], { home });
    try {
      store.append('model', 'header value my-registered-key-xyz');
      await store.close();
      const written = await fs.readFile(store.filePath!, 'utf8');
      expect(written).toContain('[redacted]');
      expect(written).not.toContain('my-registered-key-xyz');
    } finally {
      await store.close();
    }
  });

  it('keeps the memory ring within its budget (newest entries win)', () => {
    const store = new RuntimeLogStore(() => [], {
      fileSink: false,
      maxMemoryBytes: 200
    });
    for (let i = 0; i < 50; i += 1) {
      store.append('event', `frame-number-${i}`);
    }
    expect(store.memoryUsage).toBeLessThanOrEqual(200 + 20); // budget + one entry
    const tail = store.tail({ maxChars: 10_000 });
    expect(tail).toContain('frame-number-49');
    expect(tail).not.toContain('frame-number-0\n');
  });

  it('can filter tail by category', () => {
    const store = new RuntimeLogStore(() => [], { fileSink: false });
    store.append('stdout', 'hello-from-stdout');
    store.append('stderr', 'hello-from-stderr');
    const stderrOnly = store.tail({ category: 'stderr' });
    expect(stderrOnly).toContain('hello-from-stderr');
    expect(stderrOnly).not.toContain('hello-from-stdout');
  });
});
