/**
 * Settings store tests (§17/§35): read/write round-trip of settings.yaml +
 * credentials, corrupt-file tolerance, credential chmod 600 verify/repair and
 * key masking (S-4).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { maskKey, redactSecrets, SettingsStore } from '../src/main/settings/settings-store';
import { ROOT } from './helpers';

const BASE = path.join(ROOT, '.tmp-tests', 'settings');

beforeEach(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(BASE, { recursive: true });
});

afterAll(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
});

function makeStore(log?: (line: string) => void): SettingsStore {
  return new SettingsStore({
    settingsPath: path.join(BASE, 'settings.yaml'),
    credentialsPath: path.join(BASE, '.credentials.yaml'),
    log
  });
}

const VALID_SAVE = {
  name: 'deepseek',
  apiType: 'openai_compatible' as const,
  baseUrl: 'https://api.deepseek.com/v1',
  models: ['deepseek-chat'],
  apiKey: 'sk-test-secret-key-123456'
};

describe('SettingsStore', () => {
  it('saves a provider and round-trips through a new instance', () => {
    const first = makeStore();
    expect(first.saveProvider(VALID_SAVE)).toEqual({ ok: true });

    // settings.yaml never contains the key…
    const raw = fs.readFileSync(first.settingsPath, 'utf8');
    expect(raw).toContain('deepseek');
    expect(raw).not.toContain('sk-test-secret-key');

    // …the credentials file does, at mode 0600.
    const credStat = fs.statSync(first.credentialsPath);
    expect(credStat.mode & 0o777).toBe(0o600);
    const credRaw = fs.readFileSync(first.credentialsPath, 'utf8');
    expect(credRaw).toContain('sk-test-secret-key');

    const second = new SettingsStore({
      settingsPath: first.settingsPath,
      credentialsPath: first.credentialsPath
    });
    const view = second.view();
    expect(view.providers).toHaveLength(1);
    expect(view.providers[0]).toMatchObject({ name: 'deepseek', apiKeyConfigured: true });
    expect(second.getPermissionMode()).toBe('ask');
  });

  it('masks keys in views and never echoes them back', () => {
    const store = makeStore();
    store.saveProvider(VALID_SAVE);
    const view = store.view();
    const mask = view.providers[0]!.apiKeyMask!;
    expect(mask).not.toContain('sk-test-secret-key');
    expect(mask.startsWith('sk-')).toBe(true);
    expect(mask.endsWith('3456')).toBe(true);
    expect(JSON.stringify(view)).not.toContain('sk-test-secret-key');
  });

  it('rejects invalid provider input without writing files', () => {
    const store = makeStore();
    expect(store.saveProvider({ ...VALID_SAVE, name: 'bad name!' }).ok).toBe(false);
    expect(store.saveProvider({ ...VALID_SAVE, baseUrl: 'ftp://x' }).ok).toBe(false);
    expect(store.saveProvider({ ...VALID_SAVE, models: [] }).ok).toBe(false);
    const noKey = { ...VALID_SAVE, apiKey: undefined };
    expect(store.saveProvider(noKey).ok).toBe(false); // new provider needs a key
    expect(fs.existsSync(store.settingsPath)).toBe(false);
  });

  it('deletes providers together with their stored key', () => {
    const store = makeStore();
    store.saveProvider(VALID_SAVE);
    expect(store.deleteProvider('deepseek').ok).toBe(true);
    expect(store.view().providers).toHaveLength(0);
    expect(store.peekApiKey('deepseek')).toBeUndefined();

    const second = new SettingsStore({
      settingsPath: store.settingsPath,
      credentialsPath: store.credentialsPath
    });
    expect(second.peekApiKey('deepseek')).toBeUndefined();
  });

  it('tolerates corrupt yaml files and records warnings', () => {
    fs.writeFileSync(path.join(BASE, 'settings.yaml'), '{{{ not yaml', 'utf8');
    fs.writeFileSync(path.join(BASE, '.credentials.yaml'), 'providers: [oops', 'utf8');
    const store = makeStore();
    expect(store.view()).toMatchObject({ providers: [], permissionsMode: 'ask' });
    expect(store.takeWarnings().length).toBeGreaterThan(0);
    // Still writable afterwards.
    expect(store.setPermissionsMode('auto_edit').ok).toBe(true);
  });

  it('warns when settings.yaml suspiciously contains an api_key field', () => {
    fs.writeFileSync(
      path.join(BASE, 'settings.yaml'),
      'providers:\n  - name: evil\n    base_url: https://x\n    api_key: sk-leaky-key-abcd\n',
      'utf8'
    );
    const store = makeStore();
    expect(store.takeWarnings().some((w) => w.includes('api_key'))).toBe(true);
  });

  it('verifies credentials permissions and repairs wrong modes to 0600', () => {
    const store = makeStore();
    store.saveProvider(VALID_SAVE);
    fs.chmodSync(store.credentialsPath, 0o644);

    const logs: string[] = [];
    const second = new SettingsStore({
      settingsPath: store.settingsPath,
      credentialsPath: store.credentialsPath,
      log: (line) => logs.push(line)
    });
    expect(fs.statSync(store.credentialsPath).mode & 0o777).toBe(0o600);
    expect(logs.some((l) => l.includes('600'))).toBe(true);
    expect(second.peekApiKey('deepseek')).toBeDefined(); // data survived the repair
  });

  it('persists permission mode and DSH path override', () => {
    const store = makeStore();
    expect(store.setPermissionsMode('full_auto').ok).toBe(true);
    expect(store.setDshPath('/opt/dsh/bin/dsh').ok).toBe(true);

    const second = new SettingsStore({
      settingsPath: store.settingsPath,
      credentialsPath: store.credentialsPath
    });
    expect(second.getPermissionMode()).toBe('full_auto');
    expect(second.getDshPath()).toBe('/opt/dsh/bin/dsh');
    expect(second.setPermissionsMode('nonsense' as never).ok).toBe(false);
  });
});

describe('maskKey / redactSecrets helpers', () => {
  it('masks long keys but hides short ones completely', () => {
    expect(maskKey('sk-abcdefghijklmnop')).toBe('sk-…mnop');
    expect(maskKey('short')).toBe('••••••');
    expect(maskKey('')).toBe('••••••');
  });

  it('redacts every known secret occurrence', () => {
    const out = redactSecrets(
      'Authorization: Bearer sk-secret-9999 failed; retry with sk-secret-9999',
      ['sk-secret-9999']
    );
    expect(out).not.toContain('sk-secret-9999');
    expect(out.match(/\[redacted\]/g)).toHaveLength(2);
  });

  it('ignores secrets shorter than four characters to avoid mangling text', () => {
    expect(redactSecrets('ab ab ab', ['ab'])).toBe('ab ab ab');
  });
});
