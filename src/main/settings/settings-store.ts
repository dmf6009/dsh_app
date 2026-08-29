/**
 * Settings module (§30) — dsh-NATIVE persistence for `~/.dsh/settings.yaml`
 * and `~/.dsh/.credentials.yaml` (§17), permissions mode (§12) and the DSH
 * path override (§32).
 *
 * These files belong to dsh (the CLI and the web profile read/write the same
 * files), so this store is a GUEST in their schema:
 *  - Model providers live in plugin config sections:
 *      `llm-pi-ai.providers.<id>`  — multi-provider plugin (displayName,
 *                                    apiKeyEnv, api, baseURL, models[…])
 *      `llm-deepseek`              — official deepseek plugin (baseURL,
 *                                    models[…], apiKeyEnv defaults to
 *                                    DEEPSEEK_API_KEY)
 *    Models are rich objects: `{ id, name, contextWindow, maxTokens, … }`.
 *  - API keys live ONLY in `.credentials.yaml` under `refs.<apiKeyEnv>`
 *    (mode 0600, `version: 1`). A legacy desktop-only `providers.<name>.api_key`
 *    shape is still read/written for files created by early desktop builds.
 *  - Desktop-only extras (`permissions.mode`, `dsh.path`) are plain extra
 *    sections that dsh tolerates.
 *
 * Write-back therefore NEVER rewrites the whole document: at save time the
 * file is re-read from disk, parsed with `YAML.parseDocument` (CST — comments
 * and formatting of untouched nodes survive), only the owned sections are
 * merged in place, and the result is written atomically. Unknown sections
 * (`ui-onboarding`, plugin config, …) always survive. A corrupt settings.yaml
 * ABORTS the save with an error instead of clobbering it.
 *
 * Security invariants (§33/§35, baseline S-4):
 *   - API keys live ONLY in the credentials file, never in settings.yaml.
 *   - The credentials file is (re)written with mode 0600 and its mode is
 *     verified/repaired on load.
 *   - Nothing that leaves this class (views, logs, errors) contains key
 *     material: every message passes through `redactSecrets`.
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { Document } from 'yaml';
import YAML from 'yaml';

import {
  isApiType,
  isPermissionMode,
  type ApiType,
  type ModelInfo,
  type OperationResult,
  type PermissionMode,
  type ProviderConfig,
  type ProviderView,
  type SaveProviderInput,
  type SettingsView
} from '../../shared/settings';

export interface SettingsPaths {
  settingsPath?: string;
  credentialsPath?: string;
}

export interface SettingsStoreOptions extends SettingsPaths {
  home?: string;
  /** Sink for diagnostics; all output is secret-redacted. */
  log?: (line: string) => void;
}

const DEFAULT_PERMISSIONS_MODE: PermissionMode = 'ask';
const DEEPSEEK_PROVIDER_NAME = 'deepseek';
const DEEPSEEK_DEFAULT_KEY_ENV = 'DEEPSEEK_API_KEY';
const PI_AI_SECTION = 'llm-pi-ai';
const DEEPSEEK_SECTION = 'llm-deepseek';

/** Where a provider's config lives in settings.yaml (routing for write-back). */
type ProviderSection = 'pi-ai' | 'deepseek' | 'legacy';

interface InternalProvider {
  name: string;
  section: ProviderSection;
  displayName?: string;
  api_type: ApiType;
  base_url: string;
  models: ModelInfo[];
  apiKeyEnv?: string;
}

export class SettingsStore {
  readonly settingsPath: string;
  readonly credentialsPath: string;
  private readonly log: (line: string) => void;
  private readonly warnings: string[] = [];
  private providers: InternalProvider[] = [];
  /** dsh-native credential refs: env name → key (`.credentials.yaml refs`). */
  private refs: Record<string, string> = {};
  /** Legacy desktop-only credential map: provider name → key. */
  private legacyKeys: Record<string, string> = {};
  private permissionsMode: PermissionMode = DEFAULT_PERMISSIONS_MODE;
  private dshPath: string | null = null;
  private defaultModel: { provider: string; model: string } | undefined;

  constructor(options: SettingsStoreOptions = {}) {
    const home = options.home ?? homedir();
    this.settingsPath = options.settingsPath ?? path.join(home, '.dsh', 'settings.yaml');
    this.credentialsPath = options.credentialsPath ?? path.join(home, '.dsh', '.credentials.yaml');
    this.log = options.log ?? (() => {});
    this.load();
  }

  /* ------------------------------------------------------------------ */
  /* Load                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Read both files. Any corruption degrades to defaults for the affected
   * part and records a warning — a broken settings file must never crash the
   * app or block Settings from opening.
   */
  load(): SettingsView {
    this.warnings.length = 0;
    this.loadSettingsFile();
    this.loadCredentialsFile();
    return this.view();
  }

  private loadSettingsFile(): void {
    this.providers = [];
    this.permissionsMode = DEFAULT_PERMISSIONS_MODE;
    this.dshPath = null;
    this.defaultModel = undefined;
    let raw: string;
    try {
      raw = fs.readFileSync(this.settingsPath, 'utf8');
    } catch {
      return; // missing file = first run, not an error
    }
    let parsed: unknown;
    try {
      const doc = YAML.parseDocument(raw, { strict: false });
      // parseDocument COLLECTS errors instead of throwing; toJS() would throw
      // on an error document, so gate explicitly.
      if (doc.errors.length > 0) {
        throw new Error(doc.errors[0]?.message ?? 'YAML 解析错误');
      }
      parsed = doc.toJS();
    } catch (err) {
      this.warn(`settings.yaml 解析失败，已忽略并使用默认配置：${describe(err)}`);
      return;
    }
    if (parsed === null || parsed === undefined) return; // empty file = first run
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.warn('settings.yaml 顶层不是对象，已忽略并使用默认配置');
      return;
    }
    const d = parsed as Record<string, unknown>;

    /* ---- dsh-native providers ---- */

    const piAi = asRecord(d[PI_AI_SECTION]);
    const piProviders = asRecord(piAi?.['providers']);
    if (piAi && piProviders === null) {
      this.warn(`${PI_AI_SECTION} 段缺少 providers 映射，已忽略该段`);
    }
    if (piProviders) {
      for (const [id, cfg] of Object.entries(piProviders)) {
        const rec = asRecord(cfg);
        if (!rec) continue;
        this.providers.push({
          name: id,
          section: 'pi-ai',
          displayName: asString(rec['displayName']),
          api_type: nativeApiToType(rec['api']),
          // Several pi-ai providers (openrouter/google/…) use the plugin's
          // built-in endpoint and carry no baseURL at all.
          base_url: asString(rec['baseURL']) ?? '',
          models: parseModelInfos(rec['models']),
          apiKeyEnv: asString(rec['apiKeyEnv'])
        });
      }
    }

    const deepseek = asRecord(d[DEEPSEEK_SECTION]);
    if (deepseek && typeof deepseek['baseURL'] === 'string') {
      this.providers.push({
        name: DEEPSEEK_PROVIDER_NAME,
        section: 'deepseek',
        displayName: 'DeepSeek',
        api_type: 'openai_compatible',
        base_url: deepseek['baseURL'] as string,
        models: parseModelInfos(deepseek['models']),
        apiKeyEnv: asString(deepseek['apiKeyEnv']) ?? DEEPSEEK_DEFAULT_KEY_ENV
      });
    }

    /* ---- legacy desktop-only providers array ---- */

    for (const provider of parseLegacyProviders(d['providers'], this.warnings)) {
      this.providers.push({ ...provider, section: 'legacy' });
    }

    /* ---- desktop-only extras ---- */

    const permissions = asRecord(d['permissions']);
    const mode = permissions?.['mode'];
    if (isPermissionMode(mode)) {
      this.permissionsMode = mode;
    } else if (mode !== undefined) {
      this.warn('permissions.mode 无效，已重置为 ask');
    }

    const dshPath = asRecord(d['dsh'])?.['path'];
    this.dshPath = typeof dshPath === 'string' && dshPath.trim() !== '' ? dshPath : null;

    const defaultModel = asRecord(d['agent-default-model']);
    if (
      typeof defaultModel?.['provider'] === 'string' &&
      typeof defaultModel?.['model'] === 'string'
    ) {
      this.defaultModel = {
        provider: defaultModel['provider'] as string,
        model: defaultModel['model'] as string
      };
    }

    // Defence in depth: keys must never live in settings.yaml (§17/§35).
    if (/api[_-]?key/i.test(raw)) {
      this.warn('settings.yaml 中疑似包含 api_key 字段；密钥只应存在于 ~/.dsh/.credentials.yaml');
    }
  }

  private loadCredentialsFile(): void {
    this.refs = {};
    this.legacyKeys = {};
    let raw: string;
    try {
      raw = fs.readFileSync(this.credentialsPath, 'utf8');
    } catch {
      return; // missing = no keys stored yet
    }
    this.enforceCredentialPermissions();

    let parsed: unknown;
    try {
      parsed = YAML.parse(raw);
    } catch (err) {
      this.warn(`credentials 文件解析失败，已忽略已存密钥：${describe(err)}`);
      return;
    }
    if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (parsed !== null && parsed !== undefined) this.warn('credentials 文件顶层不是对象，已忽略已存密钥');
      return;
    }
    const root = parsed as Record<string, unknown>;
    const refs = asRecord(root['refs']);
    if (refs) {
      for (const [env, key] of Object.entries(refs)) {
        if (typeof key === 'string' && key !== '') this.refs[env] = key;
      }
    }
    const legacy = asRecord(root['providers']);
    if (legacy) {
      for (const [name, entry] of Object.entries(legacy)) {
        const key = asRecord(entry)?.['api_key'];
        if (typeof key === 'string' && key !== '') this.legacyKeys[name] = key;
      }
    }
  }

  /** §35: credentials 文件权限校验。Repairs to 0600 and reports when wrong. */
  enforceCredentialPermissions(): boolean {
    try {
      const stat = fs.statSync(this.credentialsPath);
      const mode = stat.mode & 0o777;
      if (mode !== 0o600) {
        fs.chmodSync(this.credentialsPath, 0o600);
        this.warn(`credentials 文件权限为 ${oct(mode)}（应为 600），已自动修复为 600`);
        return false;
      }
      return true;
    } catch {
      return true; // nothing to check yet
    }
  }

  /* ------------------------------------------------------------------ */
  /* Views                                                               */
  /* ------------------------------------------------------------------ */

  /** Renderer-facing view: masked keys only. */
  view(): SettingsView {
    return {
      providers: this.providers.map((p): ProviderView => {
        const key = this.keyOf(p);
        return {
          name: p.name,
          displayName: p.displayName,
          apiType: p.api_type,
          baseUrl: p.base_url !== '' ? p.base_url : undefined,
          models: p.models.map((m) => ({ ...m })),
          apiKeyEnv: p.apiKeyEnv,
          apiKeyConfigured: Boolean(key),
          apiKeyMask: key ? maskKey(key) : undefined
        };
      }),
      permissionsMode: this.permissionsMode,
      dshPath: this.dshPath,
      defaultModel: this.defaultModel ? { ...this.defaultModel } : undefined,
      warnings: [...this.warnings]
    };
  }

  listProviders(): ProviderConfig[] {
    return this.providers.map((p) => ({
      name: p.name,
      api_type: p.api_type,
      base_url: p.base_url,
      models: p.models.map((m) => ({ ...m }))
    }));
  }

  getPermissionMode(): PermissionMode {
    return this.permissionsMode;
  }

  getDshPath(): string | null {
    return this.dshPath;
  }

  takeWarnings(): string[] {
    return this.warnings.splice(0, this.warnings.length);
  }

  /**
   * Internal use only (model refresh / future runtime hand-off). Never expose
   * through IPC.
   */
  peekApiKey(providerName: string): string | undefined {
    const provider = this.providers.find((p) => p.name === providerName);
    if (provider) return this.keyOf(provider);
    return this.legacyKeys[providerName];
  }

  /** Every stored secret, for log redaction sinks (§33). Never log this list. */
  allSecrets(): string[] {
    return [...Object.values(this.refs), ...Object.values(this.legacyKeys)];
  }

  /* ------------------------------------------------------------------ */
  /* Mutations                                                           */
  /* ------------------------------------------------------------------ */

  saveProvider(input: SaveProviderInput): OperationResult & { warning?: string } {
    const nameError = validateProviderName(input.name);
    if (nameError) return { ok: false, error: nameError };
    const baseUrl = input.baseUrl?.trim() ?? '';
    if (baseUrl !== '' && !isHttpUrl(baseUrl)) {
      return { ok: false, error: 'Base URL 格式无效，需要 http(s):// 开头的完整地址' };
    }
    const apiType: ApiType = isApiType(input.apiType) ? input.apiType : 'openai_compatible';
    const models = normalizeModels(input.models);
    if (models.length === 0) {
      return { ok: false, error: '至少填写一个模型（需要模型 id）' };
    }

    const name = input.name.trim();
    const existing = this.providers.find((p) => p.name === name);
    const provider: InternalProvider = existing
      ? {
          ...existing,
          displayName: input.displayName?.trim() || existing.displayName,
          api_type: apiType,
          base_url: baseUrl !== '' ? baseUrl : existing.base_url,
          models
        }
      : {
          name,
          section: 'pi-ai',
          displayName: input.displayName?.trim() || undefined,
          api_type: apiType,
          base_url: baseUrl,
          models,
          apiKeyEnv: generateKeyEnv(name)
        };

    const hasNewKey = typeof input.apiKey === 'string' && input.apiKey.trim() !== '';
    const hadKey = Boolean(this.keyOf(provider));
    if (hasNewKey) {
      this.setKey(provider, input.apiKey!.trim());
    } else if (!hadKey && !existing) {
      return { ok: false, error: '请填写 API Key' };
    }

    const previousProviders = this.providers;
    const previousRefs = { ...this.refs };
    const previousLegacyKeys = { ...this.legacyKeys };
    this.providers = existing
      ? this.providers.map((p) => (p.name === name ? provider : p))
      : [...this.providers, provider];

    try {
      this.persistProviders();
      this.load(); // re-sync from disk so view state matches what was written
      return { ok: true };
    } catch (err) {
      // Roll back in-memory state so UI and disk stay consistent.
      this.providers = previousProviders;
      this.refs = previousRefs;
      this.legacyKeys = previousLegacyKeys;
      return { ok: false, error: `保存失败：${describe(err)}` };
    }
  }

  deleteProvider(name: string): OperationResult {
    const provider = this.providers.find((p) => p.name === name);
    if (!provider) return { ok: false, error: `Provider 不存在：${name}` };
    const previousProviders = this.providers;
    const previousRefs = { ...this.refs };
    const previousLegacyKeys = { ...this.legacyKeys };
    this.providers = this.providers.filter((p) => p.name !== name);
    this.deleteKey(provider);
    try {
      // Deletion is a targeted fresh-document edit: rewriting owned sections
      // from memory cannot express removing a section entirely.
      this.applyProviderRemovalToDisk(provider);
      this.load();
      return { ok: true };
    } catch (err) {
      this.providers = previousProviders;
      this.refs = previousRefs;
      this.legacyKeys = previousLegacyKeys;
      return { ok: false, error: `删除失败：${describe(err)}` };
    }
  }

  setDefaultModel(provider: string, model: string): OperationResult {
    const p = provider.trim();
    const m = model.trim();
    if (p === '' || m === '') return { ok: false, error: '默认模型的 provider 和 model 不能为空' };
    this.defaultModel = { provider: p, model: m };
    try {
      this.persistProviders();
      return { ok: true };
    } catch (err) {
      this.defaultModel = undefined;
      return { ok: false, error: `保存失败：${describe(err)}` };
    }
  }

  setPermissionsMode(mode: PermissionMode): OperationResult {
    if (!isPermissionMode(mode)) return { ok: false, error: `未知权限模式：${String(mode)}` };
    const previous = this.permissionsMode;
    this.permissionsMode = mode;
    try {
      this.persistProviders();
      return { ok: true };
    } catch (err) {
      this.permissionsMode = previous;
      return { ok: false, error: `保存失败：${describe(err)}` };
    }
  }

  setDshPath(dshPath: string | null): OperationResult {
    const next = dshPath && dshPath.trim() !== '' ? dshPath.trim() : null;
    const previous = this.dshPath;
    this.dshPath = next;
    try {
      this.persistProviders();
      return { ok: true };
    } catch (err) {
      this.dshPath = previous;
      return { ok: false, error: `保存失败：${describe(err)}` };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  private keyOf(provider: InternalProvider): string | undefined {
    if (provider.apiKeyEnv && this.refs[provider.apiKeyEnv]) return this.refs[provider.apiKeyEnv];
    return this.legacyKeys[provider.name];
  }

  private setKey(provider: InternalProvider, key: string): void {
    if (provider.section === 'legacy') {
      this.legacyKeys[provider.name] = key;
      return;
    }
    if (!provider.apiKeyEnv) provider.apiKeyEnv = generateKeyEnv(provider.name);
    this.refs[provider.apiKeyEnv] = key;
  }

  private deleteKey(provider: InternalProvider): void {
    if (provider.apiKeyEnv && this.refs[provider.apiKeyEnv]) {
      // Only drop the ref when no other provider shares this env.
      const shared = this.providers.some((p) => p !== provider && p.apiKeyEnv === provider.apiKeyEnv);
      if (!shared) delete this.refs[provider.apiKeyEnv];
    }
    delete this.legacyKeys[provider.name];
  }

  /**
   * Rewrite the sections this store OWNS onto a freshly-parsed document:
   * provider plugin sections, the legacy providers array (only if it exists),
   * permissions.mode, dsh.path and agent-default-model. Everything else on
   * disk — sections, comments, formatting — is untouched.
   */
  private persistProviders(): void {
    const settingsDoc = this.parseSettingsForWrite();
    const fresh = (settingsDoc.toJS() ?? {}) as Record<string, unknown>;

    for (const provider of this.providers) {
      if (provider.section === 'legacy') continue;
      const piProviders = asRecord(asRecord(fresh[PI_AI_SECTION])?.['providers']);
      const existingSection: Record<string, unknown> | null =
        provider.section === 'pi-ai'
          ? (piProviders?.[provider.name] as Record<string, unknown> | undefined) ?? null
          : asRecord(fresh[DEEPSEEK_SECTION]);
      settingsDoc.setIn(
        provider.section === 'pi-ai'
          ? [PI_AI_SECTION, 'providers', provider.name]
          : [DEEPSEEK_SECTION],
        buildProviderSection(provider, existingSection)
      );
    }

    // Legacy desktop providers array: rewrite only when the section exists
    // (fresh installs never grow it).
    const legacyOnDisk = Array.isArray(fresh['providers']);
    const legacyProviders = this.providers.filter((p) => p.section === 'legacy');
    if (legacyOnDisk || legacyProviders.length > 0) {
      settingsDoc.set(
        'providers',
        legacyProviders.map((p) => ({
          name: p.name,
          api_type: p.api_type,
          base_url: p.base_url,
          models: p.models.map((m) => m.id)
        }))
      );
    }

    settingsDoc.setIn(['permissions', 'mode'], this.permissionsMode);
    settingsDoc.setIn(['dsh', 'path'], this.dshPath ?? '');
    if (this.defaultModel) {
      settingsDoc.setIn(['agent-default-model'], { ...this.defaultModel });
    }

    writeYamlAtomic(this.settingsPath, settingsDoc);
    this.persistCredentials();
    if (this.log && this.credentialsPath) {
      this.log('settings.yaml 已保存（未触及的段落与注释保持原样）');
    }
  }

  /** Parse the on-disk settings for a write; a corrupt file ABORTS the save. */
  private parseSettingsForWrite(): Document {
    let raw = '';
    try {
      raw = fs.readFileSync(this.settingsPath, 'utf8');
    } catch {
      return new Document({}); // first write ever
    }
    try {
      const doc = YAML.parseDocument(raw, { strict: false });
      if (doc.errors.length > 0) throw new Error(doc.errors[0]?.message ?? 'YAML 解析错误');
      if (doc.toJS() !== null && (typeof doc.toJS() !== 'object' || Array.isArray(doc.toJS()))) {
        throw new Error('settings.yaml 顶层不是对象');
      }
      return doc;
    } catch (err) {
      throw new Error(
        `settings.yaml 无法解析（${describe(err)}）。为避免覆盖你的 dsh 配置，本次保存已取消；请先修复该文件。`
      );
    }
  }

  /** Write the refs map back onto a fresh credentials document (0600). */
  private persistCredentials(): void {
    let doc: Document;
    try {
      const raw = fs.readFileSync(this.credentialsPath, 'utf8');
      doc = YAML.parseDocument(raw, { strict: false });
      if (doc.errors.length > 0) throw new Error(doc.errors[0]?.message ?? 'YAML 解析错误');
    } catch {
      doc = new Document({ refs: {} });
    }
    const fresh = (doc.toJS() ?? {}) as Record<string, unknown>;
    const refs = asRecord(fresh['refs']) ?? {};
    // Apply in-memory ref deltas onto whatever is on disk (external refs stay).
    for (const [env, key] of Object.entries(this.refs)) {
      refs[env] = key;
    }
    for (const env of Object.keys(refs)) {
      if (this.refs[env] === undefined) delete refs[env];
    }
    doc.set('refs', refs);

    // Legacy desktop-only credentials block: keep entries for known legacy
    // providers, drop entries whose provider is gone.
    const legacyOnDisk = asRecord(fresh['providers']);
    if (legacyOnDisk || Object.keys(this.legacyKeys).length > 0) {
      const next: Record<string, { api_key: string }> = {};
      for (const [name, key] of Object.entries(this.legacyKeys)) {
        next[name] = { api_key: key };
      }
      doc.set('providers', next);
    }

    writeYamlAtomic(this.credentialsPath, doc, 0o600);
    this.enforceCredentialPermissions();
  }

  /** Targeted on-disk removal of one provider section + its credential ref. */
  private applyProviderRemovalToDisk(provider: InternalProvider): void {
    const settingsDoc = this.parseSettingsForWrite();
    if (provider.section === 'pi-ai') {
      settingsDoc.deleteIn([PI_AI_SECTION, 'providers', provider.name]);
    } else if (provider.section === 'deepseek') {
      settingsDoc.deleteIn([DEEPSEEK_SECTION]);
    } else {
      const fresh = (settingsDoc.toJS() ?? {}) as Record<string, unknown>;
      const legacy = Array.isArray(fresh['providers']) ? (fresh['providers'] as unknown[]) : [];
      settingsDoc.set(
        'providers',
        legacy.filter((entry) => asRecord(entry)?.['name'] !== provider.name)
      );
    }
    writeYamlAtomic(this.settingsPath, settingsDoc);
    this.persistCredentials();
  }

  private warn(message: string): void {
    this.log(message); // log sink redacts secrets itself
    this.warnings.push(message);
  }
}

/* -------------------------------------------------------------------- */
/* dsh-native schema helpers                                            */
/* -------------------------------------------------------------------- */

/** Map the native `api` string to the desktop ApiType (MVP: one type). */
function nativeApiToType(value: unknown): ApiType {
  // Only openai-completions exists today; unknown values fall back.
  return typeof value === 'string' && value !== '' ? 'openai_compatible' : 'openai_compatible';
}

function parseModelInfos(value: unknown): ModelInfo[] {
  if (!Array.isArray(value)) return [];
  const models: ModelInfo[] = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    if (!rec || typeof rec['id'] !== 'string' || rec['id'] === '') continue;
    models.push({
      id: rec['id'],
      name: asString(rec['name']),
      contextWindow: asNumber(rec['contextWindow']),
      maxTokens: asNumber(rec['maxTokens'])
    });
  }
  return models;
}

/** Trim + drop empties + dedupe by id, keeping first occurrence order. */
function normalizeModels(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: model.name?.trim() || undefined,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens
    });
  }
  return out;
}

/**
 * Build the YAML value for one provider section: start from the section
 * currently on disk (preserving unknown keys like imagePixelBudget /
 * inputModalities), then overlay the edited fields. Models merge by id so
 * untouched entries keep their extra fields untouched as well.
 */
function buildProviderSection(
  provider: InternalProvider,
  existing: Record<string, unknown> | null
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(existing ?? {}) };
  if (provider.section === 'pi-ai') {
    base['displayName'] = provider.displayName ?? asString(base['displayName']);
    base['apiKeyEnv'] = provider.apiKeyEnv ?? asString(base['apiKeyEnv']) ?? generateKeyEnv(provider.name);
    base['api'] = asString(base['api']) ?? 'openai-completions';
    if (!base['displayName']) delete base['displayName'];
  }
  if (provider.base_url !== '') base['baseURL'] = provider.base_url;
  const existingModels = Array.isArray(base['models']) ? (base['models'] as unknown[]) : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of existingModels) {
    const rec = asRecord(entry);
    if (rec && typeof rec['id'] === 'string') byId.set(rec['id'], rec);
  }
  base['models'] = provider.models.map((model) => {
    const raw = byId.get(model.id) ?? { id: model.id };
    const next: Record<string, unknown> = { ...raw, id: model.id };
    if (model.name !== undefined) next['name'] = model.name;
    else if (!('name' in raw)) next['name'] = model.id;
    if (model.contextWindow !== undefined) next['contextWindow'] = model.contextWindow;
    else if (!('contextWindow' in raw)) delete next['contextWindow'];
    if (model.maxTokens !== undefined) next['maxTokens'] = model.maxTokens;
    else if (!('maxTokens' in raw)) delete next['maxTokens'];
    return next;
  });
  return base;
}

/** Desktop env-var name for a new provider's credential ref. */
function generateKeyEnv(name: string): string {
  return `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

function parseLegacyProviders(value: unknown, warnings: string[]): Omit<InternalProvider, 'section'>[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push('settings.yaml providers 段不是数组，已忽略');
    return [];
  }
  const providers: Omit<InternalProvider, 'section'>[] = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    if (!rec) continue;
    if (typeof rec['name'] !== 'string' || rec['name'].trim() === '') continue;
    if (typeof rec['base_url'] !== 'string') continue;
    providers.push({
      name: rec['name'].trim(),
      api_type: isApiType(rec['api_type']) ? rec['api_type'] : 'openai_compatible',
      base_url: rec['base_url'],
      models: parseModelInfos(
        Array.isArray(rec['models'])
          ? (rec['models'] as unknown[]).map((m) => (typeof m === 'string' ? { id: m } : m))
          : undefined
      )
    });
  }
  return providers;
}

/* -------------------------------------------------------------------- */
/* Helpers                                                              */
/* -------------------------------------------------------------------- */

export function maskKey(key: string): string {
  if (key.length < 8) return '••••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/**
 * Replace every known secret occurrence with `[redacted]`. Used on any text
 * that may reach logs or stderr panels (§33: 禁止记录 API Key / 完整 Credential).
 */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

export function validateProviderName(name: unknown): string | null {
  if (typeof name !== 'string') return 'Provider 名称不能为空';
  const trimmed = name.trim();
  if (trimmed === '') return 'Provider 名称不能为空';
  if (trimmed.length > 64) return 'Provider 名称过长（≤64 字符）';
  if (!/^[\w.-]+$/u.test(trimmed)) {
    return 'Provider 名称只能包含字母、数字、点、横线、下划线';
  }
  return null;
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Atomic write; `data` may be a plain value or a yaml Document (CST kept). */
function writeYamlAtomic(filePath: string, data: unknown, mode?: number): void {
  const targetMode = mode ?? 0o644;
  const dir = path.dirname(filePath);
  // §35: the DSH config directory itself stays private to the current user.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}`;
  const text = data instanceof Document ? data.toString() : YAML.stringify(data);
  try {
    // Drop any stale leftover from a crashed run so the creation mode below
    // governs instead of inheriting old permissions.
    fs.rmSync(tmp, { force: true });
    // §35/S-4: the temp file must be restricted FROM THE FIRST BYTE — creating
    // it at the final mode closes the world-readable window between write and
    // chmod. The trailing chmod only repairs exotic umasks (creation mode is
    // subject to `& ~umask`).
    fs.writeFileSync(tmp, text, { mode: targetMode });
    fs.chmodSync(tmp, targetMode);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

function oct(mode: number): string {
  return mode.toString(8);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
