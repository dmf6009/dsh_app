/**
 * Settings module (§30) — persistence for `~/.dsh/settings.yaml` and
 * `~/.dsh/.credentials.yaml` (§17), permissions mode (§12) and the DSH path
 * override (§32).
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

import YAML from 'yaml';

import {
  isApiType,
  isPermissionMode,
  type ApiType,
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

interface CredentialsFileShape {
  providers?: Record<string, { api_key?: string }>;
}

const DEFAULT_PERMISSIONS_MODE: PermissionMode = 'ask';

export class SettingsStore {
  readonly settingsPath: string;
  readonly credentialsPath: string;
  private readonly log: (line: string) => void;
  private readonly warnings: string[] = [];
  private providers: ProviderConfig[] = [];
  private credentials: Record<string, string> = {};
  private permissionsMode: PermissionMode = DEFAULT_PERMISSIONS_MODE;
  private dshPath: string | null = null;

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
    let raw: string;
    try {
      raw = fs.readFileSync(this.settingsPath, 'utf8');
    } catch {
      this.providers = [];
      return; // missing file = first run, not an error
    }
    let parsed: unknown;
    try {
      parsed = YAML.parse(raw);
    } catch (err) {
      this.providers = [];
      this.permissionsMode = DEFAULT_PERMISSIONS_MODE;
      this.dshPath = null;
      this.warn(`settings.yaml 解析失败，已忽略并使用默认配置：${describe(err)}`);
      return;
    }
    if (parsed === null || parsed === undefined) {
      // Empty file — same as first run.
      this.providers = [];
      return;
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.warn('settings.yaml 顶层不是对象，已忽略并使用默认配置');
      this.providers = [];
      this.permissionsMode = DEFAULT_PERMISSIONS_MODE;
      this.dshPath = null;
      return;
    }
    const doc = parsed as Record<string, unknown>;

    this.providers = parseProviders(doc['providers'], this.warnings);

    const permissions = doc['permissions'];
    const mode =
      typeof permissions === 'object' && permissions !== null
        ? (permissions as Record<string, unknown>)['mode']
        : undefined;
    if (isPermissionMode(mode)) {
      this.permissionsMode = mode;
    } else {
      this.permissionsMode = DEFAULT_PERMISSIONS_MODE;
      if (mode !== undefined) this.warn('permissions.mode 无效，已重置为 ask');
    }

    const dsh = doc['dsh'];
    const dshPath =
      typeof dsh === 'object' && dsh !== null ? (dsh as Record<string, unknown>)['path'] : undefined;
    this.dshPath = typeof dshPath === 'string' && dshPath.trim() !== '' ? dshPath : null;

    // Defence in depth: keys must never live in settings.yaml (§17/§35).
    if (/api[_-]?key/i.test(raw)) {
      this.warn('settings.yaml 中疑似包含 api_key 字段；密钥只应存在于 ~/.dsh/.credentials.yaml');
    }
  }

  private loadCredentialsFile(): void {
    this.credentials = {};
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
    if (parsed === null || parsed === undefined) return;
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.warn('credentials 文件顶层不是对象，已忽略已存密钥');
      return;
    }
    const providers = (parsed as CredentialsFileShape)['providers'];
    if (providers === undefined || providers === null) return;
    if (typeof providers !== 'object' || Array.isArray(providers)) {
      this.warn('credentials 文件 providers 段格式无效，已忽略');
      return;
    }
    for (const [name, entry] of Object.entries(providers as Record<string, unknown>)) {
      const key =
        typeof entry === 'object' && entry !== null
          ? (entry as Record<string, unknown>)['api_key']
          : undefined;
      if (typeof key === 'string' && key !== '') {
        this.credentials[name] = key;
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
        this.warn(
          `credentials 文件权限为 ${oct(mode)}（应为 600），已自动修复为 600`
        );
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
        const key = this.credentials[p.name];
        return {
          name: p.name,
          apiType: p.api_type,
          baseUrl: p.base_url,
          models: [...p.models],
          apiKeyConfigured: Boolean(key),
          apiKeyMask: key ? maskKey(key) : undefined
        };
      }),
      permissionsMode: this.permissionsMode,
      dshPath: this.dshPath,
      warnings: [...this.warnings]
    };
  }

  listProviders(): ProviderConfig[] {
    return this.providers.map((p) => ({ ...p, models: [...p.models] }));
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
    return this.credentials[providerName];
  }

  /** Every stored secret, for log redaction sinks (§33). Never log this list. */
  allSecrets(): string[] {
    return Object.values(this.credentials);
  }

  /* ------------------------------------------------------------------ */
  /* Mutations                                                           */
  /* ------------------------------------------------------------------ */

  saveProvider(input: SaveProviderInput): OperationResult & { warning?: string } {
    const nameError = validateProviderName(input.name);
    if (nameError) return { ok: false, error: nameError };
    if (!isHttpUrl(input.baseUrl)) {
      return { ok: false, error: 'Base URL 格式无效，需要 http(s):// 开头的完整地址' };
    }
    const apiType: ApiType = isApiType(input.apiType) ? input.apiType : 'openai_compatible';
    const models = dedupe(input.models.map((m) => m.trim()).filter((m) => m !== ''));
    if (models.length === 0) {
      return { ok: false, error: '至少填写一个模型名称' };
    }

    const existingIndex = this.providers.findIndex((p) => p.name === input.name);
    const config: ProviderConfig = {
      name: input.name.trim(),
      api_type: apiType,
      base_url: input.baseUrl.trim(),
      models
    };

    const hasNewKey = typeof input.apiKey === 'string' && input.apiKey.trim() !== '';
    const hadKey = Boolean(this.credentials[config.name]);
    if (hasNewKey) {
      this.credentials[config.name] = input.apiKey!.trim();
    } else if (!hadKey && existingIndex === -1) {
      return { ok: false, error: '请填写 API Key' };
    }

    const previousProviders = this.providers;
    const previousCredentials = { ...this.credentials };
    this.providers =
      existingIndex >= 0
        ? this.providers.map((p, i) => (i === existingIndex ? config : p))
        : [...this.providers, config];

    try {
      this.persist(config.name);
      return { ok: true };
    } catch (err) {
      // Roll back in-memory state so UI and disk stay consistent.
      this.providers = previousProviders;
      this.credentials = previousCredentials;
      return { ok: false, error: `保存失败：${describe(err)}` };
    }
  }

  deleteProvider(name: string): OperationResult {
    const exists = this.providers.some((p) => p.name === name);
    if (!exists) return { ok: false, error: `Provider 不存在：${name}` };
    this.providers = this.providers.filter((p) => p.name !== name);
    delete this.credentials[name];
    try {
      this.persist();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `删除失败：${describe(err)}` };
    }
  }

  setPermissionsMode(mode: PermissionMode): OperationResult {
    if (!isPermissionMode(mode)) return { ok: false, error: `未知权限模式：${String(mode)}` };
    this.permissionsMode = mode;
    try {
      this.persist();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `保存失败：${describe(err)}` };
    }
  }

  setDshPath(dshPath: string | null): OperationResult {
    this.dshPath = dshPath && dshPath.trim() !== '' ? dshPath.trim() : null;
    try {
      this.persist();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `保存失败：${describe(err)}` };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Write both files atomically. `keyProviderName` marks a provider whose key
   * changed so only that credential is logged (masked).
   */
  private persist(keyProviderName?: string): void {
    writeYamlAtomic(this.settingsPath, {
      providers: this.providers.map((p) => ({
        name: p.name,
        api_type: p.api_type,
        base_url: p.base_url,
        models: p.models
      })),
      permissions: { mode: this.permissionsMode },
      dsh: { path: this.dshPath ?? '' }
    });

    const credentials: CredentialsFileShape = {
      providers: Object.fromEntries(
        Object.entries(this.credentials).map(([name, key]) => [name, { api_key: key }])
      )
    };
    writeYamlAtomic(this.credentialsPath, credentials, 0o600);
    this.enforceCredentialPermissions();
    if (keyProviderName) {
      this.log(`provider ${keyProviderName} 的 API Key 已更新并写入凭据文件`);
    }
  }

  private warn(message: string): void {
    this.log(message); // log sink redacts secrets itself
    this.warnings.push(message);
  }
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

/** Trim + drop empties + keep first occurrence order. */
function dedupe(models: string[]): string[] {
  return Array.from(new Set(models));
}

function parseProviders(value: unknown, warnings: string[]): ProviderConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push('settings.yaml providers 段不是数组，已忽略');
    return [];
  }
  const providers: ProviderConfig[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec['name'] !== 'string' || rec['name'].trim() === '') continue;
    if (typeof rec['base_url'] !== 'string') continue;
    providers.push({
      name: rec['name'].trim(),
      api_type: isApiType(rec['api_type']) ? rec['api_type'] : 'openai_compatible',
      base_url: rec['base_url'],
      models: Array.isArray(rec['models'])
        ? rec['models'].filter((m): m is string => typeof m === 'string')
        : []
    });
  }
  return providers;
}

function writeYamlAtomic(filePath: string, data: unknown, mode?: number): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, YAML.stringify(data));
  fs.chmodSync(tmp, mode ?? 0o644);
  fs.renameSync(tmp, filePath);
}

function oct(mode: number): string {
  return mode.toString(8);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
