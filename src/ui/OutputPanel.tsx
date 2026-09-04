/**
 * Middle column: the generated text, rendered token-by-token.
 *
 * Each token is a small chip. Before detection the chips are neutral; after detection
 * they are coloured by the detector's per-token score:
 *
 *   red/green list  →  green chip = token was on the green list for its context,
 *                      red chip   = it was on the red list.
 *                      (Hard mode: every scored chip should be green. Soft mode: mostly
 *                      green, red where the model was confident enough to override δ.
 *                      Mode None: ~γ green, the chance rate.)
 *   tournament      →  red→green gradient by mean g-value (0.5 = no evidence), plus an
 *                      m-cell grid above the chip showing every layer's g_ℓ(x_t) — the
 *                      figure from the SynthID paper. Watermarked text: mostly green cells;
 *                      unwatermarked: a coin-flip mix. The detection statistic is simply
 *                      (green cells) / (all cells) over the scored tokens.
 *   dashed outline  →  not scored: the first h tokens (no context) or a repeated n-gram.
 *
 * Hovering a chip shows the sampling trace recorded while it was generated (probability,
 * entropy, candidate count, which list it came from) plus the detector's score, so you
 * can compare "what the generator did" with "what the detector concluded" position by
 * position — the re-tokenisation mismatches become visible here.
 *
 * "Edit text" swaps the chips for a plain textarea so you can paraphrase, delete or
 * insert words and re-run detection to see how robust the watermark is to edits.
 */

import type { CSSProperties } from 'react';
import type { DetectionScheme, TokenScore } from '../watermark/detect';
import type { StepTrace } from '../watermark/processor';

/** One chip. `trace` comes from generation, `score` from detection; either may be absent. */
export interface DisplayToken {
  id: number;
  piece: string;
  /** Sampling-time diagnostics (only available for tokens this app generated, unedited). */
  trace?: StepTrace;
  /** Detector result, when detection has been run on this exact token sequence. */
  score?: TokenScore;
}

/** Throughput figures shown in the header after a generation finishes. */
export interface OutputStats {
  tokens: number;
  elapsedMs: number;
  /** True if the user pressed Stop before max tokens / EOS. */
  stopped: boolean;
}

export interface OutputPanelProps {
  tokens: DisplayToken[];
  /** Plain text, the source of truth for detection and for the editor. */
  text: string;
  /** Controls how scores are coloured (binary list vs. graded g-value). */
  scheme: DetectionScheme;
  stats: OutputStats | null;
  generating: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  onTextChange: (t: string) => void;
}

export function OutputPanel(p: OutputPanelProps) {
  // Only show the colour legend once detection has actually coloured something.
  const hasScores = p.tokens.some((t) => t.score);

  return (
    <section className="panel panel-output">
      <header className="panel-header">
        <h2>Output</h2>
        <div className="row gap">
          {hasScores && <Legend scheme={p.scheme} />}
          {p.stats && (
            <span className="muted small">
              {p.stats.tokens} tokens · {(p.stats.elapsedMs / 1000).toFixed(1)}s · {(p.stats.tokens / (p.stats.elapsedMs / 1000)).toFixed(1)} tok/s
              {p.stats.stopped && ' · stopped'}
            </span>
          )}
          {p.tokens.length > 0 && !p.generating && (
            <button type="button" className="btn btn-ghost small" onClick={p.onToggleEdit}>
              {p.editing ? 'Done editing' : 'Edit text'}
            </button>
          )}
        </div>
      </header>

      {p.editing ? (
        // Edit mode: a textarea over the same text. Leaving edit mode re-tokenises (App.tsx).
        <textarea className="output-editor" value={p.text} onChange={(e) => p.onTextChange(e.currentTarget.value)} spellCheck={false} />
      ) : (
        // aria-live so screen readers announce streamed tokens without stealing focus.
        <div className="output-tokens" aria-live="polite">
          {p.tokens.length === 0 && !p.generating && <span className="muted">Generated text will appear here, one chip per token.</span>}
          {p.tokens.map((t, i) => (
            <TokenChip key={i} token={t} index={i} scheme={p.scheme} />
          ))}
          {p.generating && <span className="caret" />}
        </div>
      )}

      {hasScores && <p className="legend small muted">Hover a token for its sampling trace and detector score.</p>}
    </section>
  );
}

/**
 * A single token chip with colour from the detector and a hover tooltip.
 * In tournament mode (once scored) the chip is stacked under its g-value grid.
 */
function TokenChip({ token, index, scheme }: { token: DisplayToken; index: number; scheme: DetectionScheme }) {
  const { className, style } = chipStyle(token.score, scheme);
  const title = describe(token, index);

  // Tokens can contain newlines ("\n\n" is a common single token). Show each one as a
  // visible "↵" inside the chip, then emit real line breaks *after* the chip so the
  // surrounding flow wraps like the text does (the <br>s must sit outside the inline-flex
  // stack used for the grid, otherwise they would not break the outer line).
  const parts = token.piece.split('\n');
  const newlines = parts.length - 1;
  const chip = (
    <span className={`tok ${className}`} style={style} title={title}>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < newlines && <span className="nl">↵</span>}
        </span>
      ))}
    </span>
  );
  const breaks = Array.from({ length: newlines }, (_, i) => <br key={i} />);

  const gValues = token.score?.gValues;
  if (scheme === 'tournament' && gValues) {
    return (
      <>
        <span className="tok-stack" title={title}>
          <GGrid values={gValues} dim={!token.score?.scored} />
          {chip}
        </span>
        {breaks}
      </>
    );
  }
  return (
    <>
      {chip}
      {breaks}
    </>
  );
}

/**
 * The m g-values of one token as a small grid, green = 1, red = 0 — the same picture as
 * the SynthID paper's figure. Cells are laid out in ⌈√m⌉ columns (m = 30 → 6 × 5).
 * `dim` greys the grid for unscored tokens (repeats / no context) so the eye is drawn to
 * the cells that actually feed the statistic.
 */
function GGrid({ values, dim }: { values: (0 | 1)[]; dim: boolean }) {
  const cols = Math.ceil(Math.sqrt(values.length));
  return (
    <span className={`ggrid${dim ? ' dim' : ''}`} style={{ gridTemplateColumns: `repeat(${cols}, 3px)` }} aria-hidden="true">
      {values.map((g, i) => (
        <span key={i} className={g ? 'g1' : 'g0'} />
      ))}
    </span>
  );
}

/**
 * Map a detector score to chip colouring.
 *  - no score yet          → neutral
 *  - not scored            → dashed outline
 *  - green list            → binary green / red
 *  - tournament            → alpha-blended green (g > 0.5) or red (g < 0.5); the further
 *                            from 0.5, the more saturated. 0.5 itself is nearly transparent.
 */
function chipStyle(score: TokenScore | undefined, scheme: DetectionScheme): { className: string; style?: CSSProperties } {
  if (!score) return { className: '' };
  if (!score.scored) return { className: 'unscored' };
  if (scheme === 'greenlist') return { className: score.score === 1 ? 'green' : 'red' };

  const s = score.score;
  const strength = Math.min(1, Math.abs(s - 0.5) * 2); // 0 at g=0.5, 1 at g=0 or g=1
  const rgb = s >= 0.5 ? '34,197,94' : '239,68,68';
  return {
    className: 'graded',
    style: { background: `rgba(${rgb},${(0.12 + 0.5 * strength).toFixed(2)})` },
  };
}

/**
 * Text for the native hover tooltip: token identity, then the generation trace (if we
 * have it), then the detector's view. Seeing "sampled from GREEN list" next to a red
 * detector chip is the tell-tale sign of a tokenisation mismatch.
 */
function describe(t: DisplayToken, index: number): string {
  const lines = [`token #${index}  id=${t.id}  ${JSON.stringify(t.piece)}`];
  if (t.trace) {
    lines.push(`p=${t.trace.prob.toFixed(3)} · entropy ${t.trace.entropyBits.toFixed(2)} bits · ${t.trace.numCandidates} candidates`);
    if (t.trace.green !== undefined) lines.push(t.trace.green ? 'sampled from GREEN list' : 'sampled from RED list');
    if (t.trace.meanG !== undefined) lines.push(`mean g-value at generation: ${t.trace.meanG.toFixed(2)}`);
  }
  if (t.score) {
    if (!t.score.scored) lines.push('detector: not scored (no context / repeated n-gram)');
    else lines.push(`detector score: ${t.score.score.toFixed(2)}`);
    if (t.score.gValues) {
      // e.g. "g-values (18/30 green): 1101001110 1011100101 1101110010"
      const ones = t.score.gValues.reduce<number>((a, b) => a + b, 0);
      const bits = t.score.gValues.join('').replace(/(.{10})/g, '$1 ').trim();
      lines.push(`g-values (${ones}/${t.score.gValues.length} green): ${bits}`);
    }
  }
  return lines.join('\n');
}

/** Colour key shown in the panel header once detection has run. */
function Legend({ scheme }: { scheme: DetectionScheme }) {
  return (
    <span className="legend-inline small muted">
      {scheme === 'greenlist' ? (
        <>
          <span className="tok green">green list</span> <span className="tok red">red list</span>
        </>
      ) : (
        <>
          <span className="ggrid" style={{ gridTemplateColumns: 'repeat(3, 3px)' }} aria-hidden="true">
            <span className="g1" />
            <span className="g0" />
            <span className="g1" />
            <span className="g1" />
            <span className="g1" />
            <span className="g0" />
          </span>
          <span>grid = g-values per layer (green 1, red 0)</span>{' '}
          <span className="tok graded" style={{ background: 'rgba(34,197,94,.6)' }}>
            mean g ≈ 1
          </span>{' '}
          <span className="tok graded" style={{ background: 'rgba(239,68,68,.6)' }}>
            mean g ≈ 0
          </span>
        </>
      )}{' '}
      <span className="tok unscored">not scored</span>
    </span>
  );
}
