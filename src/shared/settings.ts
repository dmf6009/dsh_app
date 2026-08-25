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

/** Provider entry as persisted (without secrets) in `~/.dsh/settings.yaml`. */
export interface ProviderConfig {
  name: string;
  api_type: ApiType;
  base_url: string;
  models: string[];
}

/**
 * Provider as exposed to the renderer: secret replaced by a boolean plus a
 * short, non-reversible mask for UX ("sk-…abcd").
 */
export interface ProviderView {
  name: string;
  apiType: ApiType;
  baseUrl: string;
  models: string[];
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
  /** Non-fatal problems found while loading (e.g. repaired credential perms). */
  warnings: string[];
}

/** Payload for saving one provider. `apiKey` empty/undefined keeps the stored key. */
export interface SaveProviderInput {
  name: string;
  apiType: ApiType;
  baseUrl: string;
  models: string[];
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
