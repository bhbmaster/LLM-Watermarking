/**
 * Small presentational building blocks shared by the three panels.
 *
 * Nothing here knows about watermarking.
 * The blocks are labelled inputs, a segmented control, a collapsible section,
 * a coloured badge, and a "?" help bubble.
 * All components are controlled: they render the given value and report changes.
 * `App.tsx` stays the single source of truth.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Gap between the bubble and its tip, and the smallest allowed margin to the window edge. */
const TIP_GAP = 8;
const TIP_MARGIN = 8;

/**
 * Hover "?" that reveals an explanation.
 *
 * The tip is drawn into `document.body` through a React portal and placed with
 * `position: fixed`, in window coordinates. That is deliberate, and it is the whole
 * point of this component:
 *
 *   An absolutely positioned tip lives inside the panel it belongs to. Any ancestor
 *   with `overflow` other than `visible` then cuts it off. The collapsible sections
 *   in the left panel did exactly that, so every tip in "Generation parameters" and
 *   "Watermarking parameters" was sliced at the section border. A portal has no such
 *   ancestor: the tip is a child of <body>, so nothing on the page can clip it, and
 *   no future `overflow` rule can bring the bug back.
 *
 * `useLayoutEffect` measures the bubble and the tip, then:
 *   - puts the tip above the bubble, or below it when the window top is too close;
 *   - centres it on the bubble, then clamps it inside the window, so a tip never
 *     leaves the page and never adds a horizontal scrollbar.
 *
 * The bubble is focusable, so keyboard users get the same text as mouse users.
 * `aria-label` carries the text to screen readers; the tip itself is `aria-hidden`
 * so the same sentence is not announced twice.
 */
export function Help({ text }: { text: string }) {
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  /** Window coordinates for the tip; null until it has been measured. */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Measure after the tip is in the DOM but before the browser paints, so it is never
  // visible in the wrong place for a frame.
  useLayoutEffect(() => {
    if (!open) return;
    const bubble = bubbleRef.current;
    const tip = tipRef.current;
    if (!bubble || !tip) return;
    const a = bubble.getBoundingClientRect();
    const t = tip.getBoundingClientRect();

    // Above the bubble by preference; below when the tip does not fit there and there is
    // more room underneath. Then clamp, so a tip taller than the space on either side is
    // still fully on screen (a short window with a long hint).
    const roomAbove = a.top - TIP_GAP - TIP_MARGIN;
    const roomBelow = window.innerHeight - a.bottom - TIP_GAP - TIP_MARGIN;
    const placeAbove = t.height <= roomAbove || roomAbove >= roomBelow;
    const wanted = placeAbove ? a.top - TIP_GAP - t.height : a.bottom + TIP_GAP;
    const top = Math.max(TIP_MARGIN, Math.min(wanted, window.innerHeight - TIP_MARGIN - t.height));

    // Centred on the bubble, then clamped into the window. Math.max wins ties, so a tip
    // wider than the window sits at the left margin instead of off-screen to the right.
    const centred = a.left + a.width / 2 - t.width / 2;
    const left = Math.max(TIP_MARGIN, Math.min(centred, window.innerWidth - TIP_MARGIN - t.width));

    setPos({ top, left });
  }, [open, text]);

  // A fixed tip does not travel with the page, so retire it when the page moves.
  // Escape closes it for keyboard users who do not want to tab away.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const show = () => {
    setPos(null); // forget the previous placement; the next layout effect measures again
    setOpen(true);
  };

  return (
    <>
      <span
        ref={bubbleRef}
        className="help"
        tabIndex={0}
        aria-label={text}
        role="img"
        onPointerEnter={show}
        onPointerLeave={() => setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
      >
        ?
      </span>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            className="tip"
            role="tooltip"
            aria-hidden="true"
            // Hidden (but laid out, so it can be measured) until the placement is known.
            style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Field label with optional help bubble, wrapping any control.
 *
 * Rendered as a <label> so clicking the caption focuses the input inside it.
 */
export function Field({ label, help, children }: { label: ReactNode; help?: string; children: ReactNode }) {
  return (
    <label className="field">
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
 * `valueAsNumber` is NaN while the user is mid-edit.
 * Examples: the field is empty, or it reads "0.".
 * Do not propagate those states. The watermark maths must not receive NaN.
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
 * Segmented control for prompt mode and watermark mode.
 *
 * This is a radio group (one of N). It uses `role="radiogroup"` and `role="radio"`.
 * The active button is filled. The option type is generic so `onChange` stays typed.
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
 * Open/closed state is local. It is not persisted.
 * Use it to hide generation parameters that users rarely change.
 * Closed children unmount. Their values still live in App.
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
 * Coloured pill. Examples: the "WebGPU" badge, or the "fits" / "downloaded" tags.
 * `tone` picks the colour via `.badge-<tone>`.
 */
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** ★★★☆☆ from a 1-5 count. Used for MMLU-derived model quality in the picker. */
export function Stars({ n, title }: { n: number; title?: string }) {
  return (
    <span className="stars" aria-label={`${n} of 5`} title={title ?? `Quality ${n}/5`}>
      {'★'.repeat(n)}
      <span className="stars-off">{'★'.repeat(5 - n)}</span>
    </span>
  );
}
