/**
 * Model list refresh (§17→§18 chain): queries an OpenAI-compatible provider's
 * `GET {base_url}/models` and returns the model id list.
 *
 * The HTTP fetch is injectable; the default uses global fetch with a hard
 * timeout. Failures return a displayable message so the Settings form can
 * show an inline error (UI spec §6.3 校验错误/保存失败 rows).
 */

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface RefreshModelsOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface RefreshModelsResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;

export async function refreshModels(options: RefreshModelsOptions): Promise<RefreshModelsResult> {
  const base = options.baseUrl.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(`${base}/models`);
  } catch {
    return { ok: false, error: 'Base URL 格式无效' };
  }

  const doFetch = options.fetchImpl ?? defaultFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await doFetch(url.toString(), {
      signal: controller.signal,
      headers: authHeaders(options.apiKey)
    });
    if (!response.ok) {
      return {
        ok: false,
        error:
          response.status === 401
            ? '401 Invalid API Key：请检查 API Key'
            : response.status === 404
              ? '404 Endpoint not found：请检查 Base URL'
              : response.status === 429
                ? '429 Rate Limit：请求过于频繁，稍后重试'
                : `模型列表请求失败（HTTP ${response.status}）`
      };
    }
    const body: unknown = await response.json();
    const models = extractModelIds(body);
    if (models === null) {
      return { ok: false, error: '响应格式不是有效的 OpenAI /models 结构（缺少 data[].id）' };
    }
    return { ok: true, models };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      error: aborted
        ? '模型列表请求超时，请检查网络或 Base URL'
        : `模型列表请求失败：${err instanceof Error ? err.message : String(err)}`
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Accept `{data:[{id}]}`; anything else → null. */
export function extractModelIds(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const data = (body as Record<string, unknown>)['data'];
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry === 'object' && entry !== null) {
      const id = (entry as Record<string, unknown>)['id'];
      if (typeof id === 'string' && id !== '') ids.push(id);
    }
  }
  return ids;
}

function defaultFetch(
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> }
): ReturnType<typeof fetch> {
  // The key travels only in the standard Authorization header (§35).
  return fetch(url, init);
}

export function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}
