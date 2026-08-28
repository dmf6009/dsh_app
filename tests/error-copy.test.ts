/**
 * §32 unified error copy tests — every scenario must produce the three-part
 * structure (发生了什么 / 为什么 / 建议动作) and preserve raw diagnostics.
 */

import { describe, expect, it } from 'vitest';

import {
  agentCrashCopy,
  describeSessionError,
  dshNotFoundCopy,
  modelApiErrorCopy,
  runtimeStartupFailedCopy,
  sessionDeleteFailedCopy,
  sessionSaveFailedCopy
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

describe('§15/§32 session persistence errors', () => {
  it('save failure warns the transcript is not on disk yet', () => {
    const c = sessionSaveFailedCopy('EACCES: permission denied');
    expect(c.scenario).toBe('session_persist');
    expect(c.what).toBe('会话保存失败');
    // The「为什么」must say the conversation is NOT safely persisted — that is
    // the AC-12 regression the user needs to know about before closing the app.
    expect(c.why).toContain('尚未成功落盘');
    expect(c.action).toContain('再次尝试保存');
    expect(c.action).toContain('~/.dsh/desktop');
    expect(c.detail).toBe('EACCES: permission denied');
  });

  it('delete failure explains the index was deliberately not mutated', () => {
    const c = sessionDeleteFailedCopy('EBUSY: resource busy');
    expect(c.scenario).toBe('session_persist');
    expect(c.what).toBe('会话删除失败');
    expect(c.why).toContain('未生效');
    expect(c.why).toContain('列表与磁盘状态分裂');
    expect(c.action).toContain('重试');
    expect(c.detail).toBe('EBUSY: resource busy');
  });

  it('describeSessionError projects the three parts + raw detail, one per line', () => {
    const text = describeSessionError(sessionSaveFailedCopy('EACCES'));
    const lines = text.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('会话保存失败');
    expect(lines[1]).toMatch(/^原因：/);
    expect(lines[2]).toMatch(/^建议：/);
    expect(lines[3]).toBe('原始信息：EACCES');
  });

  it('describeSessionError omits the detail line when there is none', () => {
    const text = describeSessionError(sessionDeleteFailedCopy());
    expect(text.split('\n')).toHaveLength(3);
    expect(text).not.toContain('原始信息');
  });
});
