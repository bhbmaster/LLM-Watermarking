/**
 * Right column: the detector.
 *
 * Generation and detection are separate. The detector gets the text, not the token ids
 * the model emitted. It has its own key field. It uses γ, h, mode, and depth from the
 * left panel. That matches a real detector: it shares the scheme and key, and it sees
 * only text.
 *
 * Experiments:
 *   wrong key -> z near 0
 *   edit the text -> z drops
 *   mode None -> z near 0
 */

import { confidenceFor, describeDetector, explainResult, verdictFor, Z_DETECT, type DetectionResult } from '../watermark/detect';
import { Help } from './controls';

export interface DetectionPanelProps {
  detectorKey: string;
  onDetectorKeyChange: (k: string) => void;
  ignoreRepeats: boolean;
  onIgnoreRepeatsChange: (v: boolean) => void;
  /**
   * true: re-tokenise the output text (what a real detector must do).
   * false: score the exact token ids the model emitted (an oracle detector).
   * Compare the two to see how tokenisation drift reduces the signal.
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
          <Help text="Re-tokenise the output text. Rebuild the green list or g-values at each position from the detector key. Run a one-sided z-test against 'no watermark'. Use γ, h, mode, and depth from the left panel." />
        </h2>
      </header>

      <label className="field">
        <span className="field-label">
          Detector key <Help text="Match the generation key. Change it to see that without the key the text carries no detectable signal." />
        </span>
        <input type="text" value={p.detectorKey} onChange={(e) => p.onDetectorKeyChange(e.currentTarget.value)} spellCheck={false} />
      </label>

      <label className="checkbox small">
        <input type="checkbox" checked={p.ignoreRepeats} onChange={(e) => p.onIgnoreRepeatsChange(e.currentTarget.checked)} />
        Score repeated n-grams once
        <Help text="A repeated (context, token) pair gives the same evidence every time. Count it once so a repetitive text does not inflate the z-score." />
      </label>

      <label className="checkbox small" title={p.canUseGeneratedTokens ? undefined : 'Only available for unedited text generated in this session.'}>
        <input
          type="checkbox"
          checked={p.retokenize || !p.canUseGeneratedTokens}
          disabled={!p.canUseGeneratedTokens}
          onChange={(e) => p.onRetokenizeChange(e.currentTarget.checked)}
        />
        Re-tokenise the text
        <Help text="On (realistic): the detector sees only text and must tokenise it again. Token boundaries can shift. Each shift corrupts the next h scores. Off (oracle): score the exact tokens the model emitted. That is the upper bound on detectability." />
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
 * The result card. Layout matches the reference design:
 *
 *   verdict (colour = level) + 1 - p
 *   observed rate vs H0 marker
 *   which test, with its parameters
 *   the raw count behind the statistic
 *   z-score, p-value
 *   explanation tailored to mode and level
 *
 * All values come from the immutable DetectionResult.
 * The card still describes that run if the user then changes the sliders.
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
            confidence <Help text="1 - p: how unlikely it is that plain, un-watermarked text would score at least this high. This is not the probability that the text is watermarked." />
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
              score <Help text="SynthID statistic: score = 1/(mT) · Σₜ Σₗ gₗ(xₜ). This is the fraction of green cells across all scored token g-value grids. Chance is 0.5. The watermark pushes the score up." />
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
          z-score <Help text={`Standard deviations above the chance expectation. z >= ${Z_DETECT} (p about 3e-5) is the usual detection threshold.`} />
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
 * Observed vs expected rate as a bar.
 * The fill is the observed green fraction (or mean g-value).
 * The thin marker is where H0 says it should sit (γ, or 0.5).
 * The gap between them, scaled by √T, is what the z-score measures.
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
