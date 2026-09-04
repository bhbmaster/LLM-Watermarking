/**
 * Right column: the detector.
 *
 * The detector is deliberately separated from generation: it gets the *text* (not the
 * token ids the model emitted), its own key field, and the scheme parameters (γ, h,
 * mode, depth) from the left panel. That mirrors reality — a detector service shares
 * the scheme and key with the generator but sees only text — and lets you try the
 * classic experiments: wrong key → z ≈ 0; edit the text → z degrades gracefully;
 * un-watermarked text (mode None) → z ≈ 0.
 */

import { confidenceFor, describeDetector, explainResult, verdictFor, Z_DETECT, type DetectionResult } from '../watermark/detect';
import { Help } from './controls';

export interface DetectionPanelProps {
  detectorKey: string;
  onDetectorKeyChange: (k: string) => void;
  ignoreRepeats: boolean;
  onIgnoreRepeatsChange: (v: boolean) => void;
  /**
   * true  → re-tokenise the output text (what a real detector must do);
   * false → score the exact token ids the model emitted (an "oracle" detector).
   * Comparing the two shows how tokenisation drift eats into the signal.
   */
  retokenize: boolean;
  onRetokenizeChange: (v: boolean) => void;
  /** Whether the oracle option is even possible (unedited text from this session). */
  canUseGeneratedTokens: boolean;
  canDetect: boolean;
  detecting: boolean;
  onDetect: () => void;
  result: DetectionResult | null;
  /** Explains why the button is disabled, if it is. */
  disabledReason?: string;
}

export function DetectionPanel(p: DetectionPanelProps) {
  const r = p.result;
  const verdict = r ? verdictFor(r.zScore) : null;

  return (
    <aside className="panel panel-right">
      <header className="panel-header">
        <h2>
          Detection{' '}
          <Help text="Re-tokenises the output text, recomputes the green list / g-values for every position from the detector key, and runs a one-sided z-test against 'no watermark'. Uses the γ, h, mode and depth from the left panel." />
        </h2>
      </header>

      <label className="field">
        <span className="field-label">
          Detector key <Help text="Should match the generation key. Change it to see that without the key the text carries no detectable signal." />
        </span>
        <input type="text" value={p.detectorKey} onChange={(e) => p.onDetectorKeyChange(e.currentTarget.value)} spellCheck={false} />
      </label>

      <label className="checkbox small">
        <input type="checkbox" checked={p.ignoreRepeats} onChange={(e) => p.onIgnoreRepeatsChange(e.currentTarget.checked)} />
        Score repeated n-grams once
        <Help text="A repeated (context, token) pair gives the same evidence every time. Counting it once prevents a repetitive text from inflating the z-score." />
      </label>

      <label className="checkbox small" title={p.canUseGeneratedTokens ? undefined : 'Only available for unedited text generated in this session.'}>
        <input
          type="checkbox"
          checked={p.retokenize || !p.canUseGeneratedTokens}
          disabled={!p.canUseGeneratedTokens}
          onChange={(e) => p.onRetokenizeChange(e.currentTarget.checked)}
        />
        Re-tokenise the text
        <Help text="On (realistic): the detector only sees text and must tokenise it again; token boundaries can shift, and each shift corrupts the next h scores. Off (oracle): score the exact tokens the model emitted — the upper bound on detectability." />
      </label>

      <button type="button" className="btn btn-secondary" onClick={p.onDetect} disabled={!p.canDetect || p.detecting} title={p.disabledReason}>
        {p.detecting ? 'Detecting…' : '🔍 Detect watermark'}
      </button>
      {!p.canDetect && p.disabledReason && <p className="muted small">{p.disabledReason}</p>}

      {r && verdict && <ResultCard result={r} level={verdict.level} label={verdict.label} />}
    </aside>
  );
}

/**
 * The result card. Layout mirrors the reference design:
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ Weak evidence of a watermark    confidence  │   ← verdict (colour = level) + 1 − p
 *   │                                    98.3%    │
 *   │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░  ▏                     │   ← observed rate vs. H0 marker
 *   │ DETECTOR      green list (γ=0.8, h=4)       │   ← which test, with its parameters
 *   │ GREEN TOKENS  172 / 200 (86%)               │   ← the raw count behind the statistic
 *   │ Z-SCORE       2.12                          │
 *   │ P-VALUE       0.017                         │
 *   │ Above chance, but below the paper's z ≥ 4…  │   ← explanation tailored to mode/level
 *   └─────────────────────────────────────────────┘
 *
 * Everything displayed comes from the immutable `DetectionResult`, so the card keeps
 * describing *that* run even if the user starts changing sliders afterwards.
 */
function ResultCard({ result: r, level, label }: { result: DetectionResult; level: 'strong' | 'weak' | 'none'; label: string }) {
  const confidence = confidenceFor(r.pValue);
  const isList = r.scheme === 'greenlist';
  return (
    <div className={`result result-${level}`}>
      {/* Verdict + confidence */}
      <div className="verdict-row">
        <div className="verdict">{label}</div>
        <div className="confidence">
          <span className="muted small">
            confidence <Help text="1 − p: how unlikely it is that plain, un-watermarked text would score at least this high. Not the probability that the text *is* watermarked." />
          </span>
          <strong>{(confidence * 100).toFixed(1)}%</strong>
        </div>
      </div>

      <RateBar observed={r.observedRate} expected={r.expectedRate} />

      {/* Statistics table. <dt> = label, <dd> = value. */}
      <dl className="stats">
        <dt>detector</dt>
        <dd className="mono">
          {describeDetector(r)}
          {r.ignoreRepeats && <span className="muted"> · repeats once</span>}
        </dd>

        {isList ? (
          <>
            <dt>green tokens</dt>
            <dd className="mono">
              {r.statistic} / {r.numScored} <span className="muted">({(r.observedRate * 100).toFixed(0)}%)</span>
            </dd>
          </>
        ) : (
          // SynthID's statistic in the same form as the paper's figure:
          //   score = 1/(mT) · Σ_t Σ_ℓ g_ℓ(x_t)  =  (green cells) / (T · m)
          // `statistic` is Σ_t mean_ℓ g, so Σ_t Σ_ℓ g = statistic · m.
          <>
            <dt>
              score <Help text="SynthID statistic: score = 1/(mT) · Σₜ Σₗ gₗ(xₜ) — the fraction of green cells across all scored tokens' g-value grids. 0.5 by chance; the watermark pushes it up." />
            </dt>
            <dd className="mono">
              {Math.round(r.statistic * r.params.depth)} / {r.numScored * r.params.depth} <span className="muted">= {r.observedRate.toFixed(3)}</span>
            </dd>
            <dt>cells</dt>
            <dd className="mono">
              <span className="muted">
                T={r.numScored} tokens × m={r.params.depth} layers
              </span>
            </dd>
          </>
        )}

        <dt>
          z-score <Help text={`Standard deviations above the chance expectation. z ≥ ${Z_DETECT} (p ≈ 3e-5) is the usual detection threshold.`} />
        </dt>
        <dd className="mono">
          <span className={`z z-${level}`}>{r.zScore.toFixed(2)}</span>
        </dd>

        <dt>
          p-value <Help text="One-sided: probability that un-watermarked text would score at least this high." />
        </dt>
        <dd className="mono">{formatP(r.pValue)}</dd>

        {/* Unscored tokens = first h (no context) + de-duplicated repeats. */}
        {r.numScored < r.perToken.length && (
          <>
            <dt>unscored</dt>
            <dd className="mono">
              {r.perToken.length - r.numScored} <span className="muted">of {r.perToken.length} tokens</span>
            </dd>
          </>
        )}
      </dl>

      <p className="explain small">{explainResult(r)}</p>
    </div>
  );
}

/**
 * Observed vs expected rate as a bar. The fill is the observed green fraction (or mean
 * g-value); the thin marker is where H0 says it should sit (γ, or 0.5). The gap between
 * them, scaled by √T, is what the z-score measures.
 */
function RateBar({ observed, expected }: { observed: number; expected: number }) {
  return (
    <div className="ratebar" title={`observed ${(observed * 100).toFixed(1)}% · expected ${(expected * 100).toFixed(1)}%`}>
      <div className="ratebar-fill" style={{ width: `${Math.min(100, observed * 100)}%` }} />
      <div className="ratebar-marker" style={{ left: `${expected * 100}%` }} />
    </div>
  );
}

/** Tiny p-values read better in scientific notation (3.2e-5) than as 0.0000. */
function formatP(p: number): string {
  if (p < 1e-4) return p.toExponential(1);
  return p.toFixed(4);
}
