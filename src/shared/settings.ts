/**
 * Settings / provider configuration types (§17, §12, §32) shared between the
 * Electron main process and the renderer.
 *
 * Security invariant (§33/§35, baseline S-4): an API key never crosses back to
 * the renderer nor enters any log. The renderer only ever sees
 * `apiKeyConfigured` plus a non-reversible mask.
 */

export const PERMISSION_MODES = ['ask', 'auto_edit', 'full_auto'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  ask: 'Ask',
  auto_edit: 'Auto Edit',
  full_auto: 'Full Auto'
};

/** §17/baseline F11: OpenAI Compatible is the one MVP API type. */
export const API_TYPES = ['openai_compatible'] as const;
export type ApiType = (typeof API_TYPES)[number];

export const API_TYPE_LABELS: Record<ApiType, string> = {
  openai_compatible: 'OpenAI Compatible'
};

export function isApiType(value: unknown): value is ApiType {
  return typeof value === 'string' && (API_TYPES as readonly string[]).includes(value);
}

/**
 * One model entry of a provider, mirroring the dsh-native settings schema
 * (`models: [{ id, name, contextWindow, maxTokens, ... }]`). Unknown fields
 * that exist on disk are preserved on write-back but not exposed here.
 */
export interface ModelInfo {
  id: string;
  /** Display name; defaults to the id when absent. */
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** Provider entry as persisted (without secrets) in `~/.dsh/settings.yaml`. */
export interface ProviderConfig {
  name: string;
  api_type: ApiType;
  /** Absent for providers using the plugin's built-in endpoint. */
  base_url: string;
  models: ModelInfo[];
}

/**
 * Provider as exposed to the renderer: secret replaced by a boolean plus a
 * short, non-reversible mask for UX ("sk-…abcd"). `name` is the stable id
 * (the dsh provider key); `displayName` is the human label when configured.
 * `baseUrl` is absent for providers using the plugin's built-in endpoint
 * (e.g. openrouter / google in the llm-pi-ai plugin).
 */
export interface ProviderView {
  name: string;
  displayName?: string;
  apiType: ApiType;
  baseUrl?: string;
  models: ModelInfo[];
  /** Env/credential-ref name this provider's key lives under (dsh schema). */
  apiKeyEnv?: string;
  apiKeyConfigured: boolean;
  /** Non-reversible display mask; absent when no key is configured. */
  apiKeyMask?: string;
}

/** Full settings document as exposed to the renderer (secrets masked). */
export interface SettingsView {
  providers: ProviderView[];
  permissionsMode: PermissionMode;
  /** Configured DSH binary path override; null = resolve from PATH. */
  dshPath: string | null;
  /** `agent-default-model` from settings.yaml (dsh native). */
  defaultModel?: { provider: string; model: string };
  /** Non-fatal problems found while loading (e.g. repaired credential perms). */
  warnings: string[];
}

/** Payload for saving one provider. `apiKey` empty/undefined keeps the stored key.
 *  `baseUrl` empty keeps/uses the plugin's built-in endpoint. */
export interface SaveProviderInput {
  name: string;
  displayName?: string;
  apiType: ApiType;
  baseUrl?: string;
  models: ModelInfo[];
  apiKey?: string;
}

export interface OperationResult {
  ok: boolean;
  error?: string;
}

/** Result of asking the provider's OpenAI-compatible `/models` endpoint. */
export interface ModelsRefreshResult extends OperationResult {
  models?: string[];
}

/** Confirmation shown on the page Settings returns to after a successful save. */
export const PROVIDER_SAVED_FLASH =
  'Provider 已保存到 ~/.dsh/settings.yaml（密钥单独存放，权限 600）';

/**
 * What the Settings page should do after a provider save attempt (§37: 保存后
 * 返回原页面).
 *
 * Kept as a pure function so the navigation contract is testable without a DOM:
 * success returns to the originating page and carries the confirmation with it,
 * failure stays put and shows the inline error.
 */
export type ProviderSaveOutcome =
  | { close: true; flash: string }
  | { close: false; message: { ok: false; text: string } };

export function providerSaveOutcome(result: OperationResult): ProviderSaveOutcome {
  if (result.ok) {
    return { close: true, flash: PROVIDER_SAVED_FLASH };
  }
  return { close: false, message: { ok: false, text: result.error ?? '保存失败' } };
}
