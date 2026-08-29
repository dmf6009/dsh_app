/**
 * Settings page (§17/§12/§32): three tabs — Models (provider form), DSH
 * (path/diagnostics) and Permissions (3-mode radio). Reached from the global
 * top-bar gear and returns to the originating page via the store's
 * `close-settings` action.
 *
 * A successful Provider save also returns to the originating page (§37: 保存后
 * 返回原页面) and hands the confirmation to that page via `close-settings`'s
 * flash, since a message rendered here would be unmounted before it is read.
 * Failed saves stay in Settings with the inline error.
 *
 * Secret handling in the renderer: the API Key input is write-only — the
 * configured key is shown as a non-reversible mask (`apiKeyMask`) and never
 * echoed back into the field.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  API_TYPES,
  API_TYPE_LABELS,
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  providerSaveOutcome,
  type ApiType,
  type ModelInfo,
  type OperationResult,
  type PermissionMode,
  type ProviderView,
  type SaveProviderInput,
  type SettingsView
} from '../../../shared/settings';
import { Banner, Button, Card, PasswordField, RadioGroup, SelectField, Tabs, TextField } from '../components/ui';
import { useApp } from '../store/app-store';
import {
  PLUGIN_KIND_LABELS,
  canRemovePlugin,
  type InstalledPlugin,
  type PluginsSnapshot
} from '../../../shared/plugins';

const TAB_ITEMS = [
  { id: 'models', label: '模型' },
  { id: 'dsh', label: 'DSH' },
  { id: 'permissions', label: '权限' },
  { id: 'plugins', label: '插件' }
] as const;

/** Editable form row for one model entry (dsh-native rich model object). */
interface ModelRow {
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
}

interface FormState {
  name: string;
  displayName: string;
  apiType: ApiType;
  baseUrl: string;
  apiKey: string;
  models: ModelRow[];
}

const EMPTY_MODEL_ROW: ModelRow = { id: '', name: '', contextWindow: '', maxTokens: '' };

const EMPTY_FORM: FormState = {
  name: '',
  displayName: '',
  apiType: API_TYPES[0]!,
  baseUrl: '',
  apiKey: '',
  models: [{ ...EMPTY_MODEL_ROW }]
};

function parseOptionalInt(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? Math.round(value) : undefined;
}

function rowsToModels(rows: ModelRow[]): ModelInfo[] {
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row.id.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      ...(row.name.trim() !== '' ? { name: row.name.trim() } : {}),
      ...(parseOptionalInt(row.contextWindow) !== undefined
        ? { contextWindow: parseOptionalInt(row.contextWindow) }
        : {}),
      ...(parseOptionalInt(row.maxTokens) !== undefined
        ? { maxTokens: parseOptionalInt(row.maxTokens) }
        : {})
    });
  }
  return out;
}

function modelLabel(model: ModelInfo): string {
  return model.name && model.name !== model.id ? `${model.name}（${model.id}）` : model.id;
}

export default function SettingsPage(): JSX.Element {
  const { state, dispatch } = useApp();
  const [tab, setTab] = useState<string>('models');

  return (
    <div className="page page-settings">
      <header className="settings-head">
        <h2 className="section-title">Settings</h2>
        <Button size="sm" variant="secondary" onClick={() => dispatch({ type: 'close-settings' })}>
          返回
        </Button>
      </header>

      {(state.settings?.warnings.length ?? 0) > 0 && (
        <Banner tone="warning" title="配置文件警告">
          <ul className="warning-list">
            {state.settings!.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Banner>
      )}

      <Tabs items={TAB_ITEMS} active={tab} onChange={setTab} />

      {tab === 'models' && <ModelsTab />}
      {tab === 'dsh' && <DshTab />}
      {tab === 'permissions' && <PermissionsTab />}
      {tab === 'plugins' && <PluginsTab />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Models tab                                                          */
/* ------------------------------------------------------------------ */

function ModelsTab(): JSX.Element {
  const { state, dispatch } = useApp();
  const settings = state.settings;
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editing, setEditing] = useState<string | null>(null); // provider name being edited
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<'name' | 'baseUrl' | 'apiKey' | 'models', string>>>({});
  const [saveMessage, setSaveMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [defaultProvider, setDefaultProvider] = useState('');
  const [defaultModelId, setDefaultModelId] = useState('');
  const [defaultSaving, setDefaultSaving] = useState(false);
  const [defaultMessage, setDefaultMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Sync the form once the settings view arrives.
  useEffect(() => {
    if (!settings || editing) return;
    setForm(EMPTY_FORM);
    setEditing(null);
  }, [settings, editing]);

  // Keep the 默认模型 selectors in sync with the loaded dsh settings.
  useEffect(() => {
    if (!settings) return;
    setDefaultProvider(settings.defaultModel?.provider ?? '');
    setDefaultModelId(settings.defaultModel?.model ?? '');
  }, [settings]);

  const updateModelRow = (index: number, patch: Partial<ModelRow>): void => {
    setForm((prev) => ({
      ...prev,
      models: prev.models.map((row, i) => (i === index ? { ...row, ...patch } : row))
    }));
  };

  const startEdit = (provider: ProviderView): void => {
    setEditing(provider.name);
    setSaveMessage(null);
    setFieldErrors({});
    setForm({
      name: provider.name,
      displayName: provider.displayName ?? '',
      apiType: provider.apiType,
      baseUrl: provider.baseUrl ?? '',
      // Write-only by design: the stored key is NEVER placed back into the
      // input; the user sees only the mask.
      apiKey: '',
      models: provider.models.map((m) => ({
        id: m.id,
        name: m.name ?? '',
        contextWindow: m.contextWindow !== undefined ? String(m.contextWindow) : '',
        maxTokens: m.maxTokens !== undefined ? String(m.maxTokens) : ''
      }))
    });
  };

  const validate = (): boolean => {
    const errors: typeof fieldErrors = {};
    if (form.name.trim() === '') errors.name = '请填写 Provider 名称';
    else if (!/^[\w.-]+$/u.test(form.name.trim())) errors.name = '仅允许字母、数字、点、下划线、连字符';
    else if (form.name.trim().length > 64) errors.name = '名称过长（≤64 字符）';
    if (form.baseUrl.trim() !== '' && !/^https?:\/\//iu.test(form.baseUrl.trim())) {
      errors.baseUrl = '必须以 http(s):// 开头（留空则使用插件内置端点）';
    }
    if (rowsToModels(form.models).length === 0) errors.models = '至少需要一个有效的模型 id';
    if (!settings?.providers.some((p) => p.name === form.name.trim()) && form.apiKey.trim() === '') {
      errors.apiKey = '新 Provider 需要填写 API Key';
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const save = async (): Promise<void> => {
    setSaveMessage(null);
    if (!validate()) return;
    const input: SaveProviderInput = {
      name: form.name.trim(),
      ...(form.displayName.trim() !== '' ? { displayName: form.displayName.trim() } : {}),
      apiType: form.apiType,
      baseUrl: form.baseUrl.trim(),
      models: rowsToModels(form.models),
      ...(form.apiKey.trim() !== '' ? { apiKey: form.apiKey.trim() } : {})
    };
    const result = await window.desktop.saveProvider(input);
    const outcome = providerSaveOutcome(result);

    // Refresh the settings view BEFORE navigating: the provider list, key masks
    // and warnings must already be current when the user comes back.
    const view = await window.desktop.getSettings();
    dispatch({ type: 'settings-view', view });

    if (!outcome.close) {
      // Failure keeps the user in Settings with the existing inline error.
      setSaveMessage(outcome.message);
      return;
    }
    setForm(EMPTY_FORM);
    setEditing(null);
    // Success returns to the page Settings was opened from (§37), carrying the
    // confirmation so it stays perceivable after navigation.
    dispatch({ type: 'close-settings', flash: outcome.flash });
  };

  const removeProvider = async (name: string): Promise<void> => {
    if (!window.confirm(`删除 Provider「${name}」？`)) return;
    await window.desktop.deleteProvider(name);
    const view = await window.desktop.getSettings();
    dispatch({ type: 'settings-view', view });
  };

  const refreshModelsList = async (): Promise<void> => {
    setFieldErrors((prev) => ({ ...prev, models: undefined }));
    if (!/^https?:\/\//iu.test(form.baseUrl.trim())) {
      setFieldErrors((prev) => ({ ...prev, baseUrl: '刷新前请先填写有效的 Base URL' }));
      return;
    }
    setRefreshing(true);
    try {
      const result = await window.desktop.refreshModels({
        providerName: editing ?? undefined,
        baseUrl: form.baseUrl.trim(),
        ...(form.apiKey.trim() !== '' ? { apiKey: form.apiKey.trim() } : {})
      });
      if (result.ok && result.models) {
        // Merge fetched ids into the rows editor: existing rows (with their
        // parameters) stay, new ids are appended once.
        const existingIds = new Set(
          form.models.map((row) => row.id.trim()).filter((id) => id !== '')
        );
        const additions = result.models.filter((id) => !existingIds.has(id));
        setForm((prev) => {
          const known = new Set(prev.models.map((row) => row.id.trim()));
          return {
            ...prev,
            models: [
              ...prev.models.filter((row) => row.id.trim() !== ''),
              ...result.models!.filter((id) => !known.has(id)).map((id) => ({ ...EMPTY_MODEL_ROW, id }))
            ]
          };
        });
        setSaveMessage({
          ok: true,
          text:
            additions.length > 0
              ? `已获取 ${result.models.length} 个模型，新增 ${additions.length} 个`
              : `已获取 ${result.models.length} 个模型（均已存在）`
        });
      } else {
        // Inline error next to the model list (§6.3 校验错误 row).
        setFieldErrors((prev) => ({ ...prev, models: result.error ?? '模型列表获取失败' }));
      }
    } finally {
      setRefreshing(false);
    }
  };

  const saveDefaultModel = async (): Promise<void> => {
    if (defaultProvider.trim() === '' || defaultModelId.trim() === '') {
      setDefaultMessage({ ok: false, text: '请先选择 Provider 和模型' });
      return;
    }
    setDefaultSaving(true);
    setDefaultMessage(null);
    try {
      const result = await window.desktop.setDefaultModel(defaultProvider.trim(), defaultModelId.trim());
      if (result.ok) {
        const view = await window.desktop.getSettings();
        dispatch({ type: 'settings-view', view });
        setDefaultMessage({ ok: true, text: '默认模型已写入 settings.yaml（agent-default-model）。' });
      } else {
        setDefaultMessage({ ok: false, text: result.error ?? '保存失败' });
      }
    } finally {
      setDefaultSaving(false);
    }
  };

  const defaultProviderOptions = (): Array<{ value: string; label: string }> => {
    const options = (settings?.providers ?? []).map((p) => ({
      value: p.name,
      label: p.displayName && p.displayName !== p.name ? `${p.displayName}（${p.name}）` : p.name
    }));
    if (defaultProvider !== '' && !options.some((o) => o.value === defaultProvider)) {
      options.unshift({ value: defaultProvider, label: `${defaultProvider}（当前配置）` });
    }
    return options;
  };

  const defaultModelOptions = (): Array<{ value: string; label: string }> => {
    const provider = settings?.providers.find((p) => p.name === defaultProvider);
    const options = (provider?.models ?? []).map((m) => ({ value: m.id, label: modelLabel(m) }));
    if (defaultModelId !== '' && !options.some((o) => o.value === defaultModelId)) {
      options.unshift({ value: defaultModelId, label: `${defaultModelId}（当前配置）` });
    }
    return options;
  };

  return (
    <div className="tab-panel" role="tabpanel" id="panel-models" aria-labelledby="tab-models">
      <section className="provider-list">
        <h3 className="panel-title">已配置的 Provider</h3>
        {!settings || settings.providers.length === 0 ? (
          <p className="empty-hint">
            未读取到任何 Provider——配置会从 <code>~/.dsh/settings.yaml</code> 的 llm 插件段（llm-pi-ai /
            llm-deepseek）自动加载，也可在下方新增。
          </p>
        ) : (
          settings.providers.map((provider) => (
            <Card
              key={provider.name}
              title={provider.displayName && provider.displayName !== provider.name ? `${provider.displayName}（${provider.name}）` : provider.name}
              meta={
                <>
                  {API_TYPE_LABELS[provider.apiType]} ·{' '}
                  {provider.baseUrl ? <code>{provider.baseUrl}</code> : '插件内置端点'} ·{' '}
                  {provider.models.length} 个模型
                  {provider.apiKeyEnv && (
                    <span className="hint"> · Key 引用 <code>{provider.apiKeyEnv}</code></span>
                  )}
                </>
              }
              actions={
                <>
                  {provider.apiKeyConfigured ? (
                    <span className="key-mask" title="API Key 已配置（掩码显示）">
                      Key {provider.apiKeyMask}
                    </span>
                  ) : (
                    <span className="key-mask key-missing">未配置 Key</span>
                  )}
                  <Button size="sm" variant="secondary" onClick={() => startEdit(provider)}>
                    编辑
                    </Button>
                  <Button size="sm" variant="danger" onClick={() => void removeProvider(provider.name)}>
                    删除
                  </Button>
                </>
              }
            >
              <span className="hint">
                模型：{provider.models.map(modelLabel).join('、') || '（无）'}
              </span>
            </Card>
          ))
        )}
      </section>

      <section className="provider-form">
        <h3 className="panel-title">{editing ? `编辑 Provider：${editing}` : '新增 Provider'}</h3>
        <TextField
          label="名称（dsh provider id）"
          value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          error={fieldErrors.name}
          placeholder="例如 st"
        />
        <TextField
          label="显示名（可选）"
          value={form.displayName}
          onChange={(e) => setForm((p) => ({ ...p, displayName: e.target.value }))}
          placeholder="例如 st"
        />
        <SelectField
          label="API Type"
          value={form.apiType}
          onChange={(e) => setForm((p) => ({ ...p, apiType: e.target.value as ApiType }))}
          options={API_TYPES.map((t) => ({ value: t, label: API_TYPE_LABELS[t] }))}
          hint="MVP 仅支持 OpenAI Compatible。"
        />
        <TextField
          label="Base URL（留空使用插件内置端点）"
          value={form.baseUrl}
          onChange={(e) => setForm((p) => ({ ...p, baseUrl: e.target.value }))}
          error={fieldErrors.baseUrl}
          placeholder="https://api.deepseek.com/v1"
        />
        <PasswordField
          label={`API Key${editing ? '（留空保留现有 Key）' : ''}`}
          value={form.apiKey}
          onChange={(e) => setForm((p) => ({ ...p, apiKey: e.target.value }))}
          error={fieldErrors.apiKey}
          placeholder={editing ? '••••••••' : 'sk-…'}
          hint="按 dsh 原生 schema 写入凭据 refs（对应 apiKeyEnv），权限 600；不出现在日志或界面中。"
        />
        <div className="field">
          <label className="field-label">模型列表（id / 显示名 / 上下文窗口 / 最大输出）</label>
          {form.models.map((row, index) => (
            <div key={index} className="model-row">
              <input
                className="field-input"
                placeholder="模型 id，如 glm-5.2"
                aria-label={`模型 ${index + 1} id`}
                value={row.id}
                onChange={(e) => updateModelRow(index, { id: e.target.value })}
              />
              <input
                className="field-input"
                placeholder="显示名"
                aria-label={`模型 ${index + 1} 显示名`}
                value={row.name}
                onChange={(e) => updateModelRow(index, { name: e.target.value })}
              />
              <input
                className="field-input"
                type="number"
                min={0}
                placeholder="上下文窗口"
                aria-label={`模型 ${index + 1} 上下文窗口`}
                value={row.contextWindow}
                onChange={(e) => updateModelRow(index, { contextWindow: e.target.value })}
              />
              <input
                className="field-input"
                type="number"
                min={0}
                placeholder="最大输出"
                aria-label={`模型 ${index + 1} 最大输出`}
                value={row.maxTokens}
                onChange={(e) => updateModelRow(index, { maxTokens: e.target.value })}
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={form.models.length <= 1}
                onClick={() =>
                  setForm((prev) => ({ ...prev, models: prev.models.filter((_, i) => i !== index) }))
                }
              >
                删除
              </Button>
            </div>
          ))}
          {fieldErrors.models && (
            <p className="field-error" role="alert">
              {fieldErrors.models}
            </p>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setForm((prev) => ({ ...prev, models: [...prev.models, { ...EMPTY_MODEL_ROW }] }))}
          >
            添加模型
          </Button>
          <p className="hint">
            模型参数（上下文窗口 / 最大输出）按 dsh 原生 schema 保存；磁盘上已有而界面未列出的字段
            （如多模态配置）在保存时原样保留。
          </p>
        </div>
        <div className="form-actions">
          <Button variant="primary" onClick={() => void save()}>
            保存
          </Button>
          <Button variant="secondary" loading={refreshing} onClick={() => void refreshModelsList()}>
            刷新模型列表
          </Button>
          {editing && (
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(null);
                setForm(EMPTY_FORM);
                setFieldErrors({});
                setSaveMessage(null);
              }}
            >
              取消编辑
            </Button>
          )}
        </div>
        {saveMessage && (
          <p className={saveMessage.ok ? 'form-ok' : 'form-error'} role={saveMessage.ok ? 'status' : 'alert'}>
            {saveMessage.text}
          </p>
        )}
      </section>

      <section className="provider-form">
        <h3 className="panel-title">默认模型（agent-default-model）</h3>
        <SelectField
          label="Provider"
          value={defaultProvider}
          onChange={(e) => {
            setDefaultProvider(e.target.value);
            setDefaultModelId('');
          }}
          options={defaultProviderOptions()}
        />
        <SelectField
          label="模型"
          value={defaultModelId}
          onChange={(e) => setDefaultModelId(e.target.value)}
          options={defaultModelOptions()}
        />
        <div className="form-actions">
          <Button variant="primary" loading={defaultSaving} onClick={() => void saveDefaultModel()}>
            保存默认模型
          </Button>
        </div>
        {defaultMessage && (
          <p className={defaultMessage.ok ? 'form-ok' : 'form-error'} role={defaultMessage.ok ? 'status' : 'alert'}>
            {defaultMessage.text}
          </p>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DSH tab                                                             */
/* ------------------------------------------------------------------ */

function DshTab(): JSX.Element {
  const { state, dispatch } = useApp();
  const [stderr, setStderr] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const redetect = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const detection = await window.desktop.detectDsh();
      dispatch({ type: 'dsh', detection });
    } finally {
      setBusy(false);
    }
  }, [dispatch]);

  const loadStderr = useCallback(async (): Promise<void> => {
    setStderr(await window.desktop.getStderrTail());
  }, []);

  useEffect(() => {
    void loadStderr();
  }, [loadStderr]);

  const choosePath = async (): Promise<void> => {
    const result = await window.desktop.chooseDshPath();
    if (result.ok) {
      await redetect();
      const view = await window.desktop.getSettings();
      dispatch({ type: 'settings-view', view });
    }
  };

  const clearOverride = async (): Promise<void> => {
    await window.desktop.setDshPath(null);
    await redetect();
    const view = await window.desktop.getSettings();
    dispatch({ type: 'settings-view', view });
  };

  const dsh = state.dsh;
  return (
    <div className="tab-panel" role="tabpanel" id="panel-dsh" aria-labelledby="tab-dsh">
      <section className="dsh-status">
        <h3 className="panel-title">DSH 检测</h3>
        <Banner
          tone={dsh?.found ? 'success' : 'error'}
          title={dsh?.found ? '已找到 DSH' : '未找到 DSH'}
        >
          {dsh?.found
            ? `${dsh.path ?? ''}${dsh.version ? ` · ${dsh.version}` : ''}`
            : (dsh?.reason ?? '尚未检测')}
        </Banner>
        <div className="form-actions">
          <Button variant="secondary" loading={busy} onClick={() => void redetect()}>
            重新检测
          </Button>
          <Button variant="secondary" onClick={() => void choosePath()}>
            选择 DSH 路径…
          </Button>
          {state.settings?.dshPath && (
            <Button variant="ghost" onClick={() => void clearOverride()}>
              清除自定义路径（当前：{state.settings.dshPath}）
            </Button>
          )}
        </div>
      </section>

      <section className="dsh-stderr">
        <h3 className="panel-title">Runtime stderr（最近输出）</h3>
        <pre className="stderr-view">{stderr || '暂无 stderr 输出。'}</pre>
        <Button size="sm" variant="ghost" onClick={() => void loadStderr()}>
          刷新
        </Button>
        <p className="hint">敏感信息已在展示前自动遮蔽。</p>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Plugins tab (dsh「万物皆可插」)                                      */
/* ------------------------------------------------------------------ */

function PluginBadges({ plugin }: { plugin: InstalledPlugin }): JSX.Element {
  return (
    <>
      <span className={`badge ${plugin.isBundle ? 'badge-info' : 'badge-neutral'}`}>
        {PLUGIN_KIND_LABELS[plugin.isBundle ? 'bundle' : 'dep']}
      </span>
      {plugin.protected && <span className="badge badge-warning">核心</span>}
    </>
  );
}

function PluginsTab(): JSX.Element {
  const [snapshot, setSnapshot] = useState<PluginsSnapshot | null>(null);
  const [spec, setSpec] = useState('');
  const [busy, setBusy] = useState<'add' | 'remove' | null>(null);
  const [removingName, setRemovingName] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setSnapshot(await window.desktop.listPlugins());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async (): Promise<void> => {
    const target = spec.trim();
    if (target === '') return;
    setBusy('add');
    setMessage(null);
    try {
      const result = await window.desktop.addPlugin(target);
      if (result.ok) {
        setSpec('');
        setMessage({ ok: true, text: `已安装 ${target}，对下一次 Agent 运行生效。` });
        setSnapshot(result.snapshot ?? (await window.desktop.listPlugins()));
      } else {
        setMessage({ ok: false, text: result.error ?? '安装失败' });
      }
    } finally {
      setBusy(null);
    }
  };

  const remove = async (name: string): Promise<void> => {
    if (!window.confirm(`卸载插件「${name}」？它将从运行 profile 的启动栈中移除。`)) return;
    setBusy('remove');
    setRemovingName(name);
    setMessage(null);
    try {
      const result = await window.desktop.removePlugin(name);
      if (result.ok) {
        setMessage({ ok: true, text: `已卸载 ${name}，对下一次 Agent 运行生效。` });
        setSnapshot(result.snapshot ?? (await window.desktop.listPlugins()));
      } else {
        setMessage({ ok: false, text: result.error ?? '卸载失败' });
      }
    } finally {
      setBusy(null);
      setRemovingName(null);
    }
  };

  const plugins = snapshot?.plugins ?? [];
  return (
    <div className="tab-panel" role="tabpanel" id="panel-plugins" aria-labelledby="tab-plugins">
      <section className="plugin-list">
        <h3 className="panel-title">
          运行 profile 的插件 <code>{snapshot?.profile ?? '…'}</code>
        </h3>
        <p className="hint">
          dsh 的核心是「万物皆可插」：npm 包即插件，可扩展模型适配、工具、UI 与工作流。
          插件束会加入 profile 的启动栈；变更对下一次 Agent 运行生效。
        </p>
        {snapshot && !snapshot.profileExists && (
          <Banner tone="info" title="该 profile 尚未初始化">
            首次安装插件时会自动创建 profile 目录并接入插件栈。
          </Banner>
        )}
        {!snapshot ? (
          <p className="empty-hint">插件列表加载中…</p>
        ) : plugins.length === 0 ? (
          <p className="empty-hint">尚未安装任何插件——把 npm 包插进来，扩展 Agent 的能力。</p>
        ) : (
          plugins.map((plugin) => (
            <Card
              key={plugin.name}
              title={plugin.name}
              meta={
                <>
                  {plugin.version ? <code>v{plugin.version}</code> : '未安装到本地'}
                  <PluginBadges plugin={plugin} />
                </>
              }
              actions={
                <Button
                  size="sm"
                  variant="danger"
                  disabled={!canRemovePlugin(plugin)}
                  title={plugin.protected ? 'dsh 核心组件，不可卸载' : undefined}
                  loading={busy === 'remove' && removingName === plugin.name}
                  onClick={() => void remove(plugin.name)}
                >
                  卸载
                </Button>
              }
            />
          ))
        )}
      </section>

      <section className="plugin-form">
        <h3 className="panel-title">安装插件</h3>
        <TextField
          label="npm 包名（可含版本范围）"
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          placeholder="@scope/dsh-plugin@^1.0.0"
        />
        <div className="form-actions">
          <Button variant="primary" loading={busy === 'add'} onClick={() => void add()}>
            安装
          </Button>
          <Button variant="secondary" onClick={() => void refresh()}>
            刷新列表
          </Button>
        </div>
        <p className="hint">安装/卸载通过官方 `dsh plugin` 命令执行，声明 dsh.bundle 的包会自动加入启动栈。</p>
        {message && (
          <p className={message.ok ? 'form-ok' : 'form-error'} role={message.ok ? 'status' : 'alert'}>
            {message.text}
          </p>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Permissions tab                                                     */
/* ------------------------------------------------------------------ */

const PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
  ask: '每个写操作与命令执行都需要逐条批准。',
  auto_edit: '自动应用工作区内文件编辑；危险命令仍需批准。',
  full_auto: '全自动执行，不做额外确认（高风险）。'
};

function PermissionsTab(): JSX.Element {
  const { state, dispatch } = useApp();
  const [saving, setSaving] = useState(false);

  const mode = state.settings?.permissionsMode;

  const change = async (next: PermissionMode): Promise<void> => {
    setSaving(true);
    try {
      const result: OperationResult = await window.desktop.setPermissionsMode(next);
      if (result.ok) {
        const view: SettingsView = await window.desktop.getSettings();
        dispatch({ type: 'settings-view', view });
      }
    } finally {
      setSaving(false);
    }
  };

  if (!mode) {
    return (
      <div className="tab-panel" role="tabpanel" id="panel-permissions" aria-labelledby="tab-permissions">
        <p className="empty-hint">设置加载中…</p>
      </div>
    );
  }

  return (
    <div className="tab-panel" role="tabpanel" id="panel-permissions" aria-labelledby="tab-permissions">
      <RadioGroup
        name="permissions-mode"
        legend="权限模式（§12）"
        value={mode}
        onChange={(value) => void change(value)}
        options={PERMISSION_MODES.map((m) => ({
          value: m,
          label: PERMISSION_MODE_LABELS[m],
          description: PERMISSION_DESCRIPTIONS[m]
        }))}
      />
      {saving && <p className="hint">保存中…</p>}
    </div>
  );
}
