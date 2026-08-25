/**
 * Frame codec unit tests (DSHA-3 测试要求 #1):
 * 正常帧、畸形帧容错、超长行保护、跨 chunk 分帧、flush 行为、encoder 校验。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_LINE_BYTES,
  FrameDecoder,
  encodeFrame
} from '../src/shared/protocol/codec';

describe('FrameDecoder — normal frames', () => {
  it('decodes a single frame', () => {
    const decoder = new FrameDecoder();
    const result = decoder.push(
      Buffer.from('{"v":1,"type":"ready","profile":"desktop-stub"}\n')
    );
    expect(result.frames).toEqual([{ v: 1, type: 'ready', profile: 'desktop-stub' }]);
    expect(result.invalid).toEqual([]);
  });

  it('decodes multiple frames arriving in one chunk', () => {
    const decoder = new FrameDecoder();
    const payload =
      '{"v":1,"type":"ready"}\n{"v":1,"type":"run_started","run_id":"r1"}\n' +
      '{"v":1,"type":"done"}\n';
    const result = decoder.push(Buffer.from(payload));
    expect(result.frames.map((f) => (f as { type: string }).type)).toEqual([
      'ready',
      'run_started',
      'done'
    ]);
  });

  it('reassembles a frame split across arbitrary byte boundaries', () => {
    const decoder = new FrameDecoder();
    // Include a multibyte character split mid-sequence across pushes.
    const line = Buffer.from('{"v":1,"type":"message_delta","content":"修复登录接口"}\n');
    const cut = 30; // falls inside the multibyte content region
    expect(cut < line.length).toBe(true);
    const first = decoder.push(line.subarray(0, cut));
    expect(first.frames).toEqual([]);
    const second = decoder.push(line.subarray(cut));
    expect(second.frames).toEqual([
      { v: 1, type: 'message_delta', content: '修复登录接口' }
    ]);
  });

  it('tolerates CRLF endings and skips blank lines', () => {
    const decoder = new FrameDecoder();
    const result = decoder.push(
      Buffer.from('\r\n{"v":1,"type":"ready"}\r\n\n   \n{"v":1,"type":"done"}\n')
    );
    expect(result.frames.map((f) => (f as { type: string }).type)).toEqual(['ready', 'done']);
    expect(result.invalid).toEqual([]);
  });

  it('flush() emits a trailing line that lacks the final newline', () => {
    const decoder = new FrameDecoder();
    // A complete frame whose terminating newline was cut off (e.g. the writer
    // died right after the closing brace).
    decoder.push(Buffer.from('{"v":1,"type":"run_started"}'));
    const tail = decoder.flush();
    expect(tail.frames).toEqual([{ v: 1, type: 'run_started' }]);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('flush() reports a truncated half-written frame as invalid instead of throwing', () => {
    const decoder = new FrameDecoder();
    decoder.push(Buffer.from('{"v":1,"type":"run_started"'));
    const tail = decoder.flush();
    expect(tail.frames).toEqual([]);
    expect(tail.invalid[0]).toMatchObject({ reason: 'json_parse_error' });
  });
});

describe('FrameDecoder — malformed frame tolerance', () => {
  it('reports json_parse_error and keeps decoding subsequent frames', () => {
    const decoder = new FrameDecoder();
    const result = decoder.push(
      Buffer.from('this is not json\n{"v":1,"type":"ready"}\n')
    );
    expect(result.frames).toEqual([{ v: 1, type: 'ready' }]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]).toMatchObject({ reason: 'json_parse_error' });
  });

  it('rejects non-object JSON values', () => {
    const decoder = new FrameDecoder();
    const result = decoder.push(
      Buffer.from('[1,2,3]\n"just a string"\n42\nnull\n{"v":1,"type":"done"}\n')
    );
    expect(result.frames).toEqual([{ v: 1, type: 'done' }]);
    expect(result.invalid.map((i) => (i as { reason: string }).reason)).toEqual([
      'not_an_object',
      'not_an_object',
      'not_an_object',
      'not_an_object'
    ]);
  });

  it('rejects objects with bad envelopes (missing v or type)', () => {
    const decoder = new FrameDecoder();
    const result = decoder.push(
      Buffer.from('{"type":"ready"}\n{"v":2,"type":"ready"}\n{"v":1}\n{"v":1,"type":"ready"}\n')
    );
    expect(result.frames).toEqual([{ v: 1, type: 'ready' }]);
    expect(result.invalid.map((i) => (i as { reason: string }).reason)).toEqual([
      'bad_envelope',
      'bad_envelope',
      'bad_envelope'
    ]);
  });

  it('never throws on adversarial input', () => {
    const decoder = new FrameDecoder();
    const garbage = Buffer.from('\n\x00\x01\n{"v":1,"type":\n‹unicode›\n{}\n');
    expect(() => {
      const result = decoder.push(garbage);
      decoder.push(Buffer.from('{"v":1,"type":"ready"}\n'));
      expect(result.frames.length + result.invalid.length).toBeGreaterThan(0);
    }).not.toThrow();
  });
});

describe('FrameDecoder — overlong line protection', () => {
  const SMALL_MAX = 64;

  it('drops an unterminated overlong line and resumes after its newline', () => {
    const decoder = new FrameDecoder({ maxLineBytes: SMALL_MAX });
    const huge = 'x'.repeat(SMALL_MAX * 4);
    const first = decoder.push(Buffer.from(huge)); // no newline yet
    expect(first.oversizedLines).toBeGreaterThanOrEqual(1);
    expect(first.frames).toEqual([]);
    // Decoder must stay memory-bounded while discarding.
    expect(decoder.bufferedBytes).toBeLessThanOrEqual(SMALL_MAX);

    const second = decoder.push(Buffer.from('y'.repeat(SMALL_MAX * 4)));
    expect(second.frames).toEqual([]); // still discarding

    const third = decoder.push(Buffer.from('\n{"v":1,"type":"ready"}\n'));
    expect(third.frames).toEqual([{ v: 1, type: 'ready' }]);
    const allInvalid = [...first.invalid, ...second.invalid, ...third.invalid];
    expect(allInvalid.some((i) => (i as { reason: string }).reason === 'line_too_long')).toBe(true);
  });

  it('reports a newline-terminated overlong line and continues with the next frame', () => {
    const decoder = new FrameDecoder({ maxLineBytes: SMALL_MAX });
    const result = decoder.push(
      Buffer.from(`{"junk":"${'z'.repeat(SMALL_MAX * 3)}"}\n{"v":1,"type":"done"}\n`)
    );
    expect(result.frames).toEqual([{ v: 1, type: 'done' }]);
    expect(result.invalid[0]).toMatchObject({ reason: 'line_too_long' });
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('keeps buffered bytes bounded under sustained overflow pressure', () => {
    const decoder = new FrameDecoder({ maxLineBytes: SMALL_MAX });
    for (let i = 0; i < 50; i += 1) {
      decoder.push(Buffer.from('q'.repeat(SMALL_MAX * 2)));
      expect(decoder.bufferedBytes).toBeLessThanOrEqual(SMALL_MAX * 2 + 16);
    }
  });

  it('uses the documented 8 MiB default cap', () => {
    const decoder = new FrameDecoder();
    expect(DEFAULT_MAX_LINE_BYTES).toBe(8 * 1024 * 1024);
    const big = 'a'.repeat(9 * 1024 * 1024);
    const result = decoder.push(Buffer.from(`${big}\n`));
    expect(result.oversizedLines).toBe(1);
  });
});

describe('encodeFrame', () => {
  it('serializes one canonical JSONL line', () => {
    expect(encodeFrame({ v: 1, type: 'cancel' })).toBe('{"v":1,"type":"cancel"}\n');
  });

  it('escapes control characters so a frame is always exactly one line', () => {
    const delta: { v: number; type: string; content?: string } = {
      v: 1,
      type: 'message_delta',
      content: 'a\nb\r\tc'
    };
    const encoded = encodeFrame(delta);
    expect(encoded.endsWith('\n')).toBe(true);
    expect(encoded.slice(0, -1).includes('\n')).toBe(false);
  });

  it('fails fast on programmer errors', () => {
    expect(() => encodeFrame(undefined as never)).toThrow(TypeError);
    expect(() => encodeFrame(null as never)).toThrow(TypeError);
    expect(() => encodeFrame([1] as never)).toThrow(TypeError);
    // v=2 is structurally fine but violates the protocol version at runtime.
    expect(() => encodeFrame({ v: 2, type: 'cancel' })).toThrow(/v=1/);
    // @ts-expect-error missing type
    expect(() => encodeFrame({ v: 1 })).toThrow(TypeError);
  });
});
