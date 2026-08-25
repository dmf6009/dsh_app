/**
 * Settings page (§17/§12/§32): three tabs — Models (provider form), DSH
 * (path/diagnostics) and Permissions (3-mode radio). Reached from the global
 * top-bar gear and returns to the originating page via the store's
 * `close-settings` action.
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
  type ApiType,
  type OperationResult,
  type PermissionMode,
  type ProviderView,
  type SaveProviderInput,
  type SettingsView
} from '../../../shared/settings';
import { Banner, Button, Card, PasswordField, RadioGroup, SelectField, Tabs, TextField } from '../components/ui';
import { useApp } from '../store/app-store';

const TAB_ITEMS = [
  { id: 'models', label: '模型' },
  { id: 'dsh', label: 'DSH' },
  { id: 'permissions', label: '权限' }
] as const;

interface FormState {
  name: string;
  apiType: ApiType;
  baseUrl: string;
  apiKey: string;
  modelsText: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  apiType: API_TYPES[0]!,
  baseUrl: '',
  apiKey: '',
  modelsText: ''
};

function parseModels(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[\n,]/u)
        .map((s) => s.trim())
        .filter((s) => s !== '')
    )
  );
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

  // Sync the form once the settings view arrives.
  useEffect(() => {
    if (!settings || editing) return;
    setForm(EMPTY_FORM);
    setEditing(null);
  }, [settings, editing]);

  const startEdit = (provider: ProviderView): void => {
    setEditing(provider.name);
    setSaveMessage(null);
    setFieldErrors({});
    setForm({
      name: provider.name,
      apiType: provider.apiType,
      baseUrl: provider.baseUrl,
      // Write-only by design: the stored key is NEVER placed back into the
      // input; the user sees only the mask.
      apiKey: '',
      modelsText: provider.models.join('\n')
    });
  };

  const validate = (): boolean => {
    const errors: typeof fieldErrors = {};
    if (form.name.trim() === '') errors.name = '请填写 Provider 名称';
    else if (!/^[\w.-]+$/u.test(form.name.trim())) errors.name = '仅允许字母、数字、点、下划线、连字符';
    else if (form.name.trim().length > 64) errors.name = '名称过长（≤64 字符）';
    if (form.baseUrl.trim() === '') errors.baseUrl = '请填写 Base URL';
    else if (!/^https?:\/\//iu.test(form.baseUrl.trim())) errors.baseUrl = '必须以 http(s):// 开头';
    const models = parseModels(form.modelsText);
    if (models.length === 0) errors.models = '至少需要一个模型';
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
      apiType: form.apiType,
      baseUrl: form.baseUrl.trim(),
      models: parseModels(form.modelsText),
      ...(form.apiKey.trim() !== '' ? { apiKey: form.apiKey.trim() } : {})
    };
    const result = await window.desktop.saveProvider(input);
    if (result.ok) {
      setSaveMessage({ ok: true, text: '已保存到 ~/.dsh/settings.yaml（密钥单独存放，权限 600）' });
      setForm(EMPTY_FORM);
      setEditing(null);
    } else {
      setSaveMessage({ ok: false, text: result.error ?? '保存失败' });
    }
    const view = await window.desktop.getSettings();
    dispatch({ type: 'settings-view', view });
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
        setForm((prev) => ({ ...prev, modelsText: result.models!.join('\n') }));
        setSaveMessage({ ok: true, text: `已获取 ${result.models.length} 个模型` });
      } else {
        // Inline error next to the model list (§6.3 校验错误 row).
        setFieldErrors((prev) => ({ ...prev, models: result.error ?? '模型列表获取失败' }));
      }
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="tab-panel" role="tabpanel" id="panel-models" aria-labelledby="tab-models">
      <section className="provider-list">
        <h3 className="panel-title">已配置的 Provider</h3>
        {!settings || settings.providers.length === 0 ? (
          <p className="empty-hint">尚未配置任何 Provider。</p>
        ) : (
          settings.providers.map((provider) => (
            <Card
              key={provider.name}
              title={provider.name}
              meta={
                <>
                  {API_TYPE_LABELS[provider.apiType]} · <code>{provider.baseUrl}</code> ·{' '}
                  {provider.models.length} 个模型
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
              <span className="hint">模型：{provider.models.join('、')}</span>
            </Card>
          ))
        )}
      </section>

      <section className="provider-form">
        <h3 className="panel-title">{editing ? `编辑 Provider：${editing}` : '新增 Provider'}</h3>
        <TextField
          label="名称"
          value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          error={fieldErrors.name}
          placeholder="例如 deepseek"
        />
        <SelectField
          label="API Type"
          value={form.apiType}
          onChange={(e) => setForm((p) => ({ ...p, apiType: e.target.value as ApiType }))}
          options={API_TYPES.map((t) => ({ value: t, label: API_TYPE_LABELS[t] }))}
          hint="MVP 仅支持 OpenAI Compatible。"
        />
        <TextField
          label="Base URL"
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
          hint="仅写入本地凭据文件（权限 600），不会出现在日志或界面中。"
        />
        <div className="field">
          <label className="field-label" htmlFor="models-text">
            模型列表
          </label>
          <textarea
            id="models-text"
            className={`field-input field-textarea${fieldErrors.models ? ' field-input-error' : ''}`}
            value={form.modelsText}
            onChange={(e) => setForm((p) => ({ ...p, modelsText: e.target.value }))}
            placeholder={'deepseek-chat\ndeepseek-reasoner'}
            rows={4}
          />
          {fieldErrors.models && (
            <p className="field-error" role="alert">
              {fieldErrors.models}
            </p>
          )}
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
