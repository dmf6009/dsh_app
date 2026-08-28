/**
 * Plugins (dsh「万物皆可插」) — shared types for profile plugin management.
 *
 * A dsh profile is a plugin stack: `~/.dsh/profiles/<name>/package.json`
 * declares `dsh.profile.bundles` (the ordered plugin-bundle layers joined
 * into the boot tree) plus plain `dependencies`. `dsh plugin --profile <name>
 * add|remove <pkg>` forwards to pnpm and then reconciles the bundle list
 * against the installed state (a dependency resolving to a `dsh.bundle`-
 * declaring package joins the stack; a removed one leaves it).
 *
 * The Desktop manages the plugins of the profile that powers its runs
 * (default `headless`, see the desktop profile adapter).
 */

export interface InstalledPlugin {
  /** Package name (npm scope allowed). */
  name: string;
  /** Installed version resolved from the profile's node_modules, if present. */
  version?: string;
  /** Part of the profile's ordered boot stack (`dsh.profile.bundles`). */
  isBundle: boolean;
  /** Core dsh component; the desktop refuses to remove it. */
  protected: boolean;
}

export interface PluginsSnapshot {
  /** Profile whose plugins the Desktop manages (default `headless`). */
  profile: string;
  /** Absolute profile directory (`~/.dsh/profiles/<profile>`). */
  profileDir: string;
  /** False when the profile has not been initialized yet (first add creates it). */
  profileExists: boolean;
  plugins: InstalledPlugin[];
}

export interface PluginMutationResult {
  ok: boolean;
  error?: string;
  /** Tail of the dsh/pnpm output — diagnostics for failures. */
  output?: string;
  /** Refreshed snapshot on success (list-after-mutate). */
  snapshot?: PluginsSnapshot;
}

/** The desktop profile adapter's run profile powering agent execution. */
export const DEFAULT_PLUGIN_PROFILE = 'headless';

/** Core host bundle — removal would break every dsh profile boot. */
export const CORE_BUNDLE = '@deepseek-ai/dsh-base';

/** Label maps shared by the renderer. */
export const PLUGIN_KIND_LABELS = { bundle: '插件束', dep: '依赖' } as const;

/**
 * Pure guard shared by main (enforcement) and renderer ( affordance):
 * core bundles can never be removed through the Desktop.
 */
export function canRemovePlugin(plugin: InstalledPlugin | undefined): boolean {
  if (!plugin) return false;
  return !plugin.protected;
}

/**
 * Name/spec validation for add/remove — registry specs only (npm package
 * name with optional version range). Also rejects flag injection into the
 * CLI argv (leading `-`, whitespace).
 */
export function isValidPluginSpec(spec: string): boolean {
  const s = spec.trim();
  if (s === '' || s.length > 214) return false;
  if (s.startsWith('-')) return false;
  if (/[\s]/u.test(s)) return false;
  // @scope/name | name | name@range | @scope/name@range
  return /^(@[\w.-]+\/)?[\w.-]+(@[\w.<>=^~|*/+.-]*)?$/u.test(s);
}
