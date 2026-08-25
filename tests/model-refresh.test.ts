/**
 * Model refresh tests (§17→§18): provider status mapping (401/404/429 and
 * generic), timeout abort, payload extraction, URL/auth handling.
 */

import { describe, expect, it } from 'vitest';

import {
  authHeaders,
  extractModelIds,
  refreshModels,
  type FetchLike
} from '../src/main/settings/model-refresh';

const BASE = 'https://api.example.com/v1';

function respond(status: number, body: unknown = {}): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  });
}

describe('refreshModels status mapping', () => {
  it('maps 401 / 404 / 429 to actionable messages', async () => {
    const r401 = await refreshModels({ baseUrl: BASE, fetchImpl: respond(401) });
    expect(r401.ok).toBe(false);
    expect(r401.error).toContain('401');
    expect(r401.error).toContain('API Key');

    const r404 = await refreshModels({ baseUrl: BASE, fetchImpl: respond(404) });
    expect(r404.ok).toBe(false);
    expect(r404.error).toContain('404');
    expect(r404.error).toContain('Base URL');

    const r429 = await refreshModels({ baseUrl: BASE, fetchImpl: respond(429) });
    expect(r429.ok).toBe(false);
    expect(r429.error).toContain('429');
  });

  it('falls back to a generic message for other statuses', async () => {
    const result = await refreshModels({ baseUrl: BASE, fetchImpl: respond(500) });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('模型列表请求失败（HTTP 500）');
  });

  it('aborts slow requests after timeoutMs and reports them distinctly', async () => {
    let sawAbort = false;
    const slow: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          sawAbort = true;
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    const result = await refreshModels({ baseUrl: BASE, fetchImpl: slow, timeoutMs: 10 });
    expect(sawAbort).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('超时');
  });

  it('surfaces network failures without treating them as timeouts', async () => {
    const failing: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await refreshModels({ baseUrl: BASE, fetchImpl: failing });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    expect(result.error).not.toContain('超时');
  });
});

describe('refreshModels payload and request shape', () => {
  it('returns model ids from a valid OpenAI /models payload', async () => {
    const result = await refreshModels({
      baseUrl: BASE,
      apiKey: 'sk-test',
      fetchImpl: respond(200, { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] })
    });
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('rejects payloads without a data[] section and trims trailing slashes on the URL', async () => {
    const seenUrls: string[] = [];
    const capture: FetchLike = async (url) => {
      seenUrls.push(url);
      return { ok: true, status: 200, json: async () => ({ object: 'list' }) };
    };
    const result = await refreshModels({ baseUrl: `${BASE}///`, fetchImpl: capture });
    expect(seenUrls[0]).toBe(`${BASE}/models`);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('data[].id');
  });

  it('rejects malformed base URLs before any fetch', async () => {
    let called = false;
    const spy: FetchLike = async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const result = await refreshModels({ baseUrl: '::not-a-url::', fetchImpl: spy });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Base URL 格式无效');
  });
});

describe('extractModelIds / authHeaders', () => {
  it('accepts only string ids inside data[]', () => {
    expect(extractModelIds(null)).toBeNull();
    expect(extractModelIds({ data: 'nope' })).toBeNull();
    expect(
      extractModelIds({ data: [{ id: 'a' }, { id: '' }, { id: 42 }, {}, { id: 'b' }] })
    ).toEqual(['a', 'b']);
  });

  it('sends the key only as a bearer header when present', () => {
    expect(authHeaders(undefined)).toEqual({});
    expect(authHeaders('')).toEqual({});
    expect(authHeaders('sk-secret')).toEqual({ Authorization: 'Bearer sk-secret' });
  });
});
