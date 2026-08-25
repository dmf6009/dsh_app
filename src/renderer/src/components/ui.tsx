/**
 * Base component layer (§30 组件层): buttons, inputs, selects, badges,
 * banners, spinners, tabs — all with hover / focus-visible / pressed /
 * disabled states (baseline F2), correct DOM order for focus flow, and
 * zero runtime dependencies beyond react.
 */

import {
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes
} from 'react';

/* ------------------------------------------------------------------ */
/* Spinner                                                             */
/* ------------------------------------------------------------------ */

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <span className="spinner" role="status" aria-label={label ?? '加载中'}>
      <span className="spinner-dot" />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  loading?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps): JSX.Element {
  const classes = ['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={classes}
      // A loading button is also unfocusable-free: keep it in the tab order
      // but inert, matching the spec's disabled-row behaviour (§3.3).
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Text / password fields                                              */
/* ------------------------------------------------------------------ */

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function TextField({ label, hint, error, id, className, ...rest }: TextFieldProps): JSX.Element {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className={`field-input${error ? ' field-input-error' : ''}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
        {...rest}
      />
      {error ? (
        <p className="field-error" id={`${inputId}-error`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint" id={`${inputId}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Password input WITHOUT any reveal/copy affordance (S-4: key never re-exposed). */
export function PasswordField(props: Omit<TextFieldProps, 'type'>): JSX.Element {
  return <TextField type="password" autoComplete="off" spellCheck={false} {...props} />;
}

/* ------------------------------------------------------------------ */
/* Select                                                              */
/* ------------------------------------------------------------------ */

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  options: readonly SelectOption[];
  hint?: string;
}

export function SelectField({
  label,
  options,
  hint,
  id,
  className,
  ...rest
}: SelectFieldProps): JSX.Element {
  const autoId = useId();
  const selectId = id ?? autoId;
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      <label className="field-label" htmlFor={selectId}>
        {label}
      </label>
      <select id={selectId} className="field-select" {...rest}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Badge                                                               */
/* ------------------------------------------------------------------ */

export function Badge({
  tone = 'neutral',
  children
}: {
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  children: ReactNode;
}): JSX.Element {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/* ------------------------------------------------------------------ */
/* Banner (Home DSH detection states, inline errors)                   */
/* ------------------------------------------------------------------ */

export function Banner({
  tone,
  title,
  children,
  actions
}: {
  tone: 'info' | 'success' | 'warning' | 'error';
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <section className={`banner banner-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="banner-body">
        <strong className="banner-title">{title}</strong>
        {children && <div className="banner-text">{children}</div>}
      </div>
      {actions && <div className="banner-actions">{actions}</div>}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

export function Card({
  title,
  meta,
  actions,
  children,
  dimmed = false
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  dimmed?: boolean;
}): JSX.Element {
  return (
    <article className={`card${dimmed ? ' card-dimmed' : ''}`}>
      <header className="card-head">
        <div className="card-title-wrap">
          <span className="card-title">{title}</span>
          {meta && <span className="card-meta">{meta}</span>}
        </div>
        {actions && <div className="card-actions">{actions}</div>}
      </header>
      {children}
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Tabs (roving tabindex + arrow-key navigation)                       */
/* ------------------------------------------------------------------ */

export interface TabItem {
  id: string;
  label: string;
}

export function Tabs({
  items,
  active,
  onChange
}: {
  items: readonly TabItem[];
  active: string;
  onChange: (id: string) => void;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);

  const moveFocus = (dir: 1 | -1): void => {
    const tabs = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []
    );
    if (tabs.length === 0) return;
    const current = tabs.findIndex((el) => el.getAttribute('aria-selected') === 'true');
    const next = (current + dir + tabs.length) % tabs.length;
    const target = tabs[next]!;
    target.focus();
    onChange(target.dataset.tabId ?? target.id);
  };

  return (
    <div className="tabs" ref={listRef} role="tablist">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          data-tab-id={item.id}
          id={`tab-${item.id}`}
          aria-selected={item.id === active}
          aria-controls={`panel-${item.id}`}
          tabIndex={item.id === active ? 0 : -1}
          className={`tab${item.id === active ? ' tab-active' : ''}`}
          onClick={() => onChange(item.id)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') {
              e.preventDefault();
              moveFocus(1);
            } else if (e.key === 'ArrowLeft') {
              e.preventDefault();
              moveFocus(-1);
            }
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Radio group                                                         */
/* ------------------------------------------------------------------ */

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

export function RadioGroup<T extends string>({
  name,
  legend,
  options,
  value,
  onChange
}: {
  name: string;
  legend: string;
  options: readonly RadioOption<T>[];
  value: T;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <fieldset className="radio-group">
      <legend className="field-label">{legend}</legend>
      {options.map((opt) => (
        <label key={opt.value} className={`radio-row${value === opt.value ? ' radio-row-active' : ''}`}>
          <input
            type="radio"
            name={name}
            value={opt.value}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
          />
          <span className="radio-text">
            <span className="radio-label">{opt.label}</span>
            {opt.description && <span className="radio-desc">{opt.description}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/* ------------------------------------------------------------------ */
/* Modal-less confirm helper (window.confirm is fine for MVP records)  */
/* ------------------------------------------------------------------ */

export function useConfirm(): (message: string) => boolean {
  return (message: string): boolean => window.confirm(message);
}

/** Tiny hook for one-shot async action state used across forms. */
export function useAsyncAction<A extends unknown[]>(
  fn: (...args: A) => Promise<void>
): { run: (...args: A) => Promise<void>; busy: boolean } {
  const [busy, setBusy] = useState(false);
  return {
    busy,
    run: async (...args: A) => {
      if (busy) return;
      setBusy(true);
      try {
        await fn(...args);
      } finally {
        setBusy(false);
      }
    }
  };
}
