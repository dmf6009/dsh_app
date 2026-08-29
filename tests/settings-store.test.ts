/**
 * Settings store tests (§17/§35): dsh-NATIVE schema round-trip of
 * settings.yaml + credentials, corrupt-file tolerance (load degrades, save
 * aborts instead of clobbering), credential chmod 600 verify/repair, unknown
 * section/field preservation and key masking (S-4).
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

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
  models: [{ id: 'deepseek-chat' }],
  apiKey: 'sk-test-secret-key-123456'
};

/** Shaped like the user's real ~/.dsh/settings.yaml (dsh-native schema). */
const NATIVE_YAML = `# dsh settings — user comment that must survive writes
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
llm-deepseek:
  baseURL: https://ap-gateway.intra.weibo.com/openai
  models:
    - id: dashscope/deepseek-v4-flash
      name: DeepSeek-V4-Flash
      contextWindow: 1000000
      inputModalities:
        - text
llm-pi-ai:
  providers:
    st:
      displayName: st
      apiKeyEnv: ST_API_KEY
      api: openai-completions
      baseURL: https://token.sensenova.cn/v1
      models:
        - id: glm-5.2
          name: GLM-5.2
          contextWindow: 1048576
          imagePixelBudget: 640000
        - id: sensenova-u1-fast
          name: sensenova-u1-fast
          contextWindow: 262144
agent-default-model:
  provider: st
  model: glm-5.2
`;

const NATIVE_CREDENTIALS = `refs:
  ST_API_KEY: sk-st-secret-9999999999
  OTHER_REF: keep-me-value
version: 1
`;

function seedNative(): void {
  fs.writeFileSync(path.join(BASE, 'settings.yaml'), NATIVE_YAML, 'utf8');
  fs.writeFileSync(path.join(BASE, '.credentials.yaml'), NATIVE_CREDENTIALS, 'utf8');
}

describe('SettingsStore — dsh native schema', () => {
  it('loads llm-pi-ai / llm-deepseek providers, rich models, refs keys and default model', () => {
    seedNative();
    const store = makeStore();
    const view = store.view();

    expect(view.providers.map((p) => p.name)).toEqual(['st', 'deepseek']);
    const st = view.providers[0]!;
    expect(st).toMatchObject({
      displayName: 'st',
      baseUrl: 'https://token.sensenova.cn/v1',
      apiKeyEnv: 'ST_API_KEY',
      apiKeyConfigured: true
    });
    expect(st.models).toEqual([
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1048576 },
      { id: 'sensenova-u1-fast', name: 'sensenova-u1-fast', contextWindow: 262144 }
    ]);
    expect(st.apiKeyMask).not.toContain('sk-st-secret');

    const deepseek = view.providers[1]!;
    expect(deepseek).toMatchObject({
      name: 'deepseek',
      displayName: 'DeepSeek',
      baseUrl: 'https://ap-gateway.intra.weibo.com/openai',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      apiKeyConfigured: false
    });
    expect(deepseek.models[0]).toMatchObject({ id: 'dashscope/deepseek-v4-flash', contextWindow: 1000000 });

    expect(view.defaultModel).toEqual({ provider: 'st', model: 'glm-5.2' });
  });

  it('editing a provider preserves unknown sections, comments and unknown model fields', () => {
    seedNative();
    const store = makeStore();
    const result = store.saveProvider({
      name: 'st',
      apiType: 'openai_compatible',
      baseUrl: 'https://token.sensenova.cn/v1',
      models: [
        { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 999_999 },
        { id: 'new-model', name: '新模型', maxTokens: 4096 }
      ]
    });
    expect(result).toEqual({ ok: true });

    const raw = fs.readFileSync(path.join(BASE, 'settings.yaml'), 'utf8');
    // Unknown sections + the top comment survive.
    expect(raw).toContain('welcomeNoticeVersion: 2026-08-13.1');
    expect(raw).toContain('# dsh settings — user comment that must survive writes');
    expect(raw).toContain('agent-default-model:');

    const doc = YAML.parse(raw) as Record<string, unknown>;
    const st = (doc as Record<string, unknown>)['llm-pi-ai'] as Record<string, unknown>;
    const stProvider = (
      ((st['providers'] as Record<string, unknown>)['st']) as Record<string, unknown>
    );
    const models = stProvider['models'] as Record<string, unknown>[];
    expect(models).toHaveLength(2);
    // Edited parameters are written…
    expect(models[0]).toMatchObject({ id: 'glm-5.2', contextWindow: 999_999 });
    // …unknown fields of a touched entry survive…
    expect(models[0]!['imagePixelBudget']).toBe(640000);
    // …and the removed entry is gone while the new one is appended.
    expect(models.some((m) => m['id'] === 'sensenova-u1-fast')).toBe(false);
    expect(models[1]).toMatchObject({ id: 'new-model', name: '新模型', maxTokens: 4096 });

    // Credentials: untouched external refs + version survive.
    const credRaw = fs.readFileSync(path.join(BASE, '.credentials.yaml'), 'utf8');
    expect(credRaw).toContain('OTHER_REF: keep-me-value');
    expect(credRaw).toContain('version: 1');
  });

  it('a new provider lands in llm-pi-ai.providers with a generated key env ref', () => {
    seedNative();
    const store = makeStore();
    expect(
      store.saveProvider({
        name: 'foo',
        apiType: 'openai_compatible',
        baseUrl: 'https://foo.example.com/v1',
        models: [{ id: 'foo-mini', name: 'Foo Mini', contextWindow: 128_000 }],
        apiKey: 'sk-foo-secret-key-777'
      }).ok
    ).toBe(true);

    const doc = YAML.parse(fs.readFileSync(path.join(BASE, 'settings.yaml'), 'utf8')) as Record<string, unknown>;
    const foo = (((doc['llm-pi-ai'] as Record<string, unknown>)['providers'] as Record<string, unknown>)[
      'foo'
    ]) as Record<string, unknown>;
    expect(foo).toMatchObject({
      apiKeyEnv: 'FOO_API_KEY',
      api: 'openai-completions',
      baseURL: 'https://foo.example.com/v1'
    });
    expect('displayName' in foo).toBe(false);
    expect((foo['models'] as Record<string, unknown>[])[0]).toMatchObject({ id: 'foo-mini', contextWindow: 128_000 });

    const cred = YAML.parse(fs.readFileSync(path.join(BASE, '.credentials.yaml'), 'utf8')) as Record<string, unknown>;
    const refs = cred['refs'] as Record<string, string>;
    expect(refs['FOO_API_KEY']).toBe('sk-foo-secret-key-777');
    expect(refs['ST_API_KEY']).toBeDefined(); // existing ref untouched
    expect(fs.statSync(path.join(BASE, '.credentials.yaml')).mode & 0o777).toBe(0o600);

    // Round-trips through a new instance.
    const second = makeStore();
    const fooView = second.view().providers.find((p) => p.name === 'foo')!;
    expect(fooView.apiKeyConfigured).toBe(true);
    expect(fooView.models[0]).toMatchObject({ id: 'foo-mini' });
  });

  it('editing the deepseek provider writes the llm-deepseek section in place', () => {
    seedNative();
    const store = makeStore();
    expect(
      store.saveProvider({
        name: 'deepseek',
        apiType: 'openai_compatible',
        baseUrl: 'https://new-gateway.example.com/openai',
        models: [{ id: 'dashscope/deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 2_000_000 }]
      }).ok
    ).toBe(true);

    const doc = YAML.parse(fs.readFileSync(path.join(BASE, 'settings.yaml'), 'utf8')) as Record<string, unknown>;
    const section = doc['llm-deepseek'] as Record<string, unknown>;
    expect(section['baseURL']).toBe('https://new-gateway.example.com/openai');
    const model = (section['models'] as Record<string, unknown>[])[0]!;
    expect(model).toMatchObject({ id: 'dashscope/deepseek-v4-flash', contextWindow: 2_000_000 });
    expect(model['inputModalities']).toEqual(['text']); // unknown field preserved
    expect(section['apiKeyEnv']).toBeUndefined(); // native section shape untouched

    const view = store.view().providers.find((p) => p.name === 'deepseek')!;
    expect(view.baseUrl).toBe('https://new-gateway.example.com/openai');
    expect(view.models[0]!.contextWindow).toBe(2_000_000);
  });

  it('deleting a native provider removes its section and its credential ref only', () => {
    seedNative();
    const store = makeStore();
    expect(store.deleteProvider('st').ok).toBe(true);

    const raw = fs.readFileSync(path.join(BASE, 'settings.yaml'), 'utf8');
    expect(raw).not.toContain('sensenova');
    expect(raw).toContain('llm-deepseek'); // sibling section untouched
    expect(raw).toContain('agent-default-model');

    const cred = YAML.parse(fs.readFileSync(path.join(BASE, '.credentials.yaml'), 'utf8')) as Record<string, unknown>;
    const refs = cred['refs'] as Record<string, string>;
    expect(refs['ST_API_KEY']).toBeUndefined();
    expect(refs['OTHER_REF']).toBe('keep-me-value');
    expect(cred['version']).toBe(1);
  });

  it('reads and writes agent-default-model via setDefaultModel', () => {
    seedNative();
    const store = makeStore();
    expect(store.setDefaultModel('st', 'sensenova-u1-fast').ok).toBe(true);

    const doc = YAML.parse(fs.readFileSync(path.join(BASE, 'settings.yaml'), 'utf8')) as Record<string, unknown>;
    expect(doc['agent-default-model']).toEqual({ provider: 'st', model: 'sensenova-u1-fast' });

    const second = makeStore();
    expect(second.view().defaultModel).toEqual({ provider: 'st', model: 'sensenova-u1-fast' });
    expect(store.setDefaultModel('', 'x').ok).toBe(false);
  });

  it('reads the legacy desktop providers array and credentials shape (back-compat)', () => {
    fs.writeFileSync(
      path.join(BASE, 'settings.yaml'),
      YAML.stringify({
        providers: [{ name: 'old', api_type: 'openai_compatible', base_url: 'https://old.example.com', models: ['old-model'] }],
        permissions: { mode: 'auto_edit' }
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(BASE, '.credentials.yaml'),
      YAML.stringify({ providers: { old: { api_key: 'sk-legacy-key-4321' } } }),
      'utf8'
    );
    const store = makeStore();
    const provider = store.view().providers.find((p) => p.name === 'old')!;
    expect(provider).toMatchObject({ baseUrl: 'https://old.example.com', apiKeyConfigured: true });
    expect(store.getPermissionMode()).toBe('auto_edit');
    expect(store.peekApiKey('old')).toBe('sk-legacy-key-4321');

    // Editing the legacy provider keeps it in the legacy array shape.
    expect(
      store.saveProvider({
        name: 'old',
        apiType: 'openai_compatible',
        baseUrl: 'https://old.example.com',
        models: [{ id: 'old-model' }, { id: 'old-model-2' }]
      }).ok
    ).toBe(true);
    const doc = YAML.parse(fs.readFileSync(path.join(BASE, 'settings.yaml'), 'utf8')) as Record<string, unknown>;
    const legacy = (doc['providers'] as Record<string, unknown>[])[0]!;
    expect(legacy['models']).toEqual(['old-model', 'old-model-2']); // legacy shape: string ids
  });

  it('ABORTS a save when settings.yaml is corrupt instead of clobbering it', () => {
    const garbage = '{{{ definitely not: yaml: [';
    fs.writeFileSync(path.join(BASE, 'settings.yaml'), garbage, 'utf8');
    const store = makeStore();
    const result = store.saveProvider(VALID_SAVE);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('无法解析');
    expect(fs.readFileSync(path.join(BASE, 'settings.yaml'), 'utf8')).toBe(garbage);
  });
});

describe('SettingsStore — basics', () => {
  it('saves a provider on a fresh install and round-trips through a new instance', () => {
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
    expect(store.saveProvider({ ...VALID_SAVE, models: [{ id: '  ' }] }).ok).toBe(false);
    const noKey = { ...VALID_SAVE, apiKey: undefined };
    expect(store.saveProvider(noKey).ok).toBe(false); // new provider needs a key
    expect(fs.existsSync(store.settingsPath)).toBe(false);
  });

  it('tolerates corrupt yaml on load, and refuses to overwrite it on save', () => {
    fs.writeFileSync(path.join(BASE, 'settings.yaml'), '{{{ not yaml', 'utf8');
    fs.writeFileSync(path.join(BASE, '.credentials.yaml'), 'providers: [oops', 'utf8');
    const store = makeStore();
    expect(store.view()).toMatchObject({ providers: [], permissionsMode: 'ask' });
    expect(store.takeWarnings().length).toBeGreaterThan(0);
    // Saving over a corrupt file must fail with a diagnosable error, never
    // destroy whatever the user had there.
    const result = store.setPermissionsMode('auto_edit');
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('无法解析');
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

  it('creates credential temp files already restricted — no permission window (B-1)', () => {
    const store = makeStore();
    const spy = vi.spyOn(fs, 'writeFileSync');
    try {
      expect(store.saveProvider(VALID_SAVE).ok).toBe(true);
      const tmpCalls = spy.mock.calls.filter((call) =>
        String(call[0]).includes('.credentials.yaml.tmp-')
      );
      expect(tmpCalls.length).toBeGreaterThan(0);
      for (const call of tmpCalls) {
        // The temp file must be born at 0600, not chmod'ed after a wide write.
        const options = call[2] as { mode?: number } | string | undefined | null;
        expect(options).toEqual(expect.objectContaining({ mode: 0o600 }));
      }
    } finally {
      spy.mockRestore();
    }
    expect(fs.statSync(store.credentialsPath).mode & 0o777).toBe(0o600);
  });

  it('creates the settings directory private (0700) when it does not exist', () => {
    const nested = path.join(BASE, 'deep', 'dir');
    const store = new SettingsStore({
      settingsPath: path.join(nested, 'settings.yaml'),
      credentialsPath: path.join(nested, '.credentials.yaml')
    });
    expect(store.saveProvider(VALID_SAVE).ok).toBe(true);
    expect(fs.statSync(nested).mode & 0o777).toBe(0o700);
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
