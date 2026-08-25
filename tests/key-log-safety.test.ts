/**
 * Key log safety (§33, baseline S-4): no operation of the settings store may
 * leak API key material into its log sink, and every string the renderer can
 * observe (views, warnings, errors) must be free of secrets.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { redactSecrets, SettingsStore } from '../src/main/settings/settings-store';
import { ROOT } from './helpers';

const BASE = path.join(ROOT, '.tmp-tests', 'key-log-safety');
const SECRET = 'sk-super-secret-key-9876543210abcdef';

beforeEach(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(BASE, { recursive: true });
});

afterAll(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
});

function makeStore(): { store: SettingsStore; logs: () => string[] } {
  const captured: string[] = [];
  const sink = (line: string): void => {
    // The production main process wraps this sink in redactSecrets; emulate
    // that here exactly as src/main/index.ts does.
    captured.push(line);
  };
  const store = new SettingsStore({
    settingsPath: path.join(BASE, 'settings.yaml'),
    credentialsPath: path.join(BASE, '.credentials.yaml'),
    log: sink
  });
  return { store, logs: () => captured };
}

const SECRET_IN_ANY_OUTPUT = (text: string): void => {
  expect(text.includes(SECRET)).toBe(false);
};

describe('API keys never reach logs or renderer-visible strings', () => {
  it('save/delete/setPermissions/setDshPath emit no secret to the log sink', () => {
    const { store, logs } = makeStore();

    expect(store.saveProvider({ name: 'p1', apiType: 'openai_compatible', baseUrl: 'https://api.example.com/v1', models: ['m1'], apiKey: SECRET }).ok).toBe(true);
    expect(store.deleteProvider('p1').ok).toBe(true);
    expect(store.setPermissionsMode('auto_edit').ok).toBe(true);
    expect(store.setDshPath('/usr/bin/dsh').ok).toBe(true);
    expect(store.saveProvider({ name: 'p2', apiType: 'openai_compatible', baseUrl: 'https://api.example.com/v2', models: ['m2'], apiKey: SECRET }).ok).toBe(true);

    for (const line of logs()) SECRET_IN_ANY_OUTPUT(line);

    // Corrupt-file load paths also log — re-open over garbage.
    fs.writeFileSync(path.join(BASE, 'settings.yaml'), 'a: [b: c', 'utf8');
    const reopenedLogs: string[] = [];
    new SettingsStore({
      settingsPath: path.join(BASE, 'settings.yaml'),
      credentialsPath: path.join(BASE, '.credentials.yaml'),
      log: (l) => reopenedLogs.push(l)
    });
    for (const line of reopenedLogs) SECRET_IN_ANY_OUTPUT(line);
  });

  it('renderer-visible view/warnings/errors never contain the key', () => {
    const { store } = makeStore();
    store.saveProvider({ name: 'p1', apiType: 'openai_compatible', baseUrl: 'https://api.example.com/v1', models: ['m1'], apiKey: SECRET });

    SECRET_IN_ANY_OUTPUT(JSON.stringify(store.view()));
    for (const warning of store.takeWarnings()) SECRET_IN_ANY_OUTPUT(warning);

    const failure = store.saveProvider({ name: 'bad!', apiType: 'openai_compatible', baseUrl: 'https://x/v1', models: ['m'], apiKey: SECRET });
    SECRET_IN_ANY_OUTPUT(failure.error ?? '');
  });

  it('redactSecrets scrubs stderr-style text containing the key', () => {
    const noisy = `stderr: booting with key ${SECRET} ... done`;
    const clean = redactSecrets(noisy, [SECRET]);
    expect(clean).toBe('stderr: booting with key [redacted] ... done');
  });

  it('the on-disk settings.yaml stays key-free across mutations', () => {
    const { store } = makeStore();
    store.saveProvider({ name: 'p1', apiType: 'openai_compatible', baseUrl: 'https://x/v1', models: ['m'], apiKey: SECRET });
    store.setPermissionsMode('full_auto');
    store.setDshPath(null);
    const raw = fs.readFileSync(store.settingsPath, 'utf8');
    SECRET_IN_ANY_OUTPUT(raw);
  });
});
