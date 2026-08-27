/**
 * §32 unified error copy tests — every scenario must produce the three-part
 * structure (发生了什么 / 为什么 / 建议动作) and preserve raw diagnostics.
 */

import { describe, expect, it } from 'vitest';

import {
  agentCrashCopy,
  dshNotFoundCopy,
  modelApiErrorCopy,
  runtimeStartupFailedCopy
} from '../src/shared/error-copy';

describe('§32 model API errors (401/404/429/other)', () => {
  it('maps 401 to key-invalid copy with raw detail', () => {
    const c = modelApiErrorCopy('invalid api key sk-xxxx', '401');
    expect(c.scenario).toBe('model_api');
    expect(c.what).toContain('401');
    expect(c.why).toContain('API Key');
    expect(c.action).toContain('Settings');
    expect(c.detail).toBe('invalid api key sk-xxxx');
    expect(c.code).toBe('401');
  });

  it('maps 404 to not-found copy', () => {
    const c = modelApiErrorCopy('model not found', '404');
    expect(c.what).toContain('404');
    expect(c.why).toContain('Base URL');
  });

  it('maps 429 to rate-limit copy', () => {
    const c = modelApiErrorCopy('too many requests', '429');
    expect(c.what).toContain('429');
    expect(c.action).toContain('重试');
  });

  it('falls back for unknown codes', () => {
    const c = modelApiErrorCopy('boom', '500');
    expect(c.what).toBe('模型接口返回错误');
    expect(c.detail).toBe('boom');
  });
});

describe('§32 agent crash', () => {
  it('builds crash copy with exit/signal detail and session-preserved why', () => {
    const c = agentCrashCopy(137, 'SIGKILL', 'trailing stderr');
    expect(c.scenario).toBe('agent_crash');
    expect(c.why).toContain('会话已保留');
    expect(c.action).toContain('重启 Runtime');
    expect(c.detail).toBe('trailing stderr');
  });

  it('synthesizes a detail line when no stderr is given', () => {
    const c = agentCrashCopy(null, null);
    expect(c.detail).toContain('exit=—');
    expect(c.detail).toContain('signal=—');
  });
});

describe('§32 runtime startup failure', () => {
  it('builds startup-failure copy with stderr detail', () => {
    const c = runtimeStartupFailedCopy('Error: spawn dsh ENOENT');
    expect(c.what).toBe('Runtime 启动失败');
    expect(c.why).toContain('就绪');
    expect(c.action).toContain('重试启动');
    expect(c.detail).toBe('Error: spawn dsh ENOENT');
  });
});

describe('§32 DSH not found', () => {
  it('builds not-found copy with install / choose-path action', () => {
    const c = dshNotFoundCopy();
    expect(c.what).toBe('未找到 DeepSeek Harness');
    expect(c.action).toContain('Choose DSH Path');
    expect(c.action).toContain('安装');
  });

  it('uses the provided reason when present', () => {
    const c = dshNotFoundCopy('custom reason');
    expect(c.why).toBe('custom reason');
  });
});
