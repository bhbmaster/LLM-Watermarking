/**
 * Small presentational building blocks shared by the three panels.
 *
 * Nothing here knows about watermarking; it's just labelled inputs, a segmented
 * control, a collapsible section, a coloured badge and the little "?" help bubble.
 * All components are *controlled*: they render the value they are given and report
 * changes through a callback, so the single source of truth stays in `App.tsx`.
 */

import { useState, type ReactNode } from 'react';

/**
 * Hover "?" that reveals an explanation.
 *
 * Implemented as a pure-CSS tooltip: the text lives in `data-tip` and `.help:hover::after`
 * in styles.css renders it. No JS positioning, no portals — good enough for short hints
 * and it works inside <label> elements without stealing clicks. `aria-label` makes the
 * same text available to screen readers.
 */
export function Help({ text }: { text: string }) {
  return (
    <span className="help" data-tip={text} aria-label={text} role="img">
      ?
    </span>
  );
}

/**
 * Field label with optional help bubble, wrapping any control.
 *
 * Rendered as a <label> so clicking the caption focuses the input inside it. `inline`
 * lays label and control side by side instead of stacked.
 */
export function Field({ label, help, children, inline }: { label: ReactNode; help?: string; children: ReactNode; inline?: boolean }) {
  return (
    <label className={`field${inline ? ' field-inline' : ''}`}>
      <span className="field-label">
        {label}
        {help && <Help text={help} />}
      </span>
      {children}
    </label>
  );
}

interface NumberFieldProps {
  label: ReactNode;
  help?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}

/**
 * Numeric input that clamps to [min, max] and ignores half-typed garbage.
 *
 * `valueAsNumber` is NaN while the user is mid-edit (e.g. the field is empty or reads
 * "0."); we simply don't propagate those states, so the parameter objects in App never
 * hold a NaN that would poison the watermark maths.
 */
export function NumberField({ label, help, value, onChange, min, max, step, disabled }: NumberFieldProps) {
  return (
    <Field label={label} help={help}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step ?? 'any'}
        disabled={disabled}
        onChange={(e) => {
          const v = e.currentTarget.valueAsNumber;
          if (Number.isNaN(v)) return;
          const lo = min ?? -Infinity;
          const hi = max ?? Infinity;
          onChange(Math.min(hi, Math.max(lo, v)));
        }}
      />
    </Field>
  );
}

interface SegmentedProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}

/**
 * iOS-style segmented control used for prompt mode and watermark mode.
 *
 * Semantically a radio group (one of N), so it carries `role="radiogroup"` with
 * `role="radio"` + `aria-checked` children; visually it's a row of buttons where the
 * active one is filled. Generic over the option type so callers get a typed `onChange`.
 */
export function Segmented<T extends string>({ options, value, onChange, disabled }: SegmentedProps<T>) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'active' : ''}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * "▶ Title" that expands to show its children.
 *
 * Open/closed state is local (not persisted) — it's purely a layout affordance to keep
 * the rarely-touched generation parameters out of the way. Children are unmounted when
 * closed, which is fine because all their values live in App.
 */
export function Collapsible({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`collapsible${open ? ' open' : ''}`}>
      <button type="button" className="collapsible-header" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="chevron">{open ? '▼' : '▶'}</span> {title}
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </section>
  );
}

/**
 * Coloured pill, e.g. the "WebGPU" badge next to the status line or the "fits" /
 * "downloaded" tags in the model picker. `tone` picks the colour via `.badge-<tone>`.
 */
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** ★★★☆☆ from a 1–5 count. Used for MMLU-derived model quality in the picker. */
export function Stars({ n, title }: { n: number; title?: string }) {
  return (
    <span className="stars" aria-label={`${n} of 5`} title={title ?? `Quality ${n}/5`}>
      {'★'.repeat(n)}
      <span className="stars-off">{'★'.repeat(5 - n)}</span>
    </span>
  );
}
