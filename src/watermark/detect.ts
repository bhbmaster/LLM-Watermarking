/**
 * Watermark detection: "does this text look like it was written with our secret key?"
 *
 * The detector is a separate program from the generator. It does not get the prompt
 * and it does not get the token ids the model originally emitted. It gets:
 *   - the text (then we turn it into tokens again),
 *   - the secret key,
 *   - the scheme settings (γ, h, mode, depth).
 *
 * For each token after the first h, it rebuilds the same seed the generator used
 * (hash of key + previous h tokens) and scores that token:
 *
 *   red/green scheme:  1 if the token was on the green list, else 0
 *   tournament scheme: mean of the m coin-flips g_ℓ(token), a number in [0, 1]
 *
 * Then it runs a one-sided z-test against "no watermark was applied":
 *
 *   Green list: each scored token is green with chance γ, so
 *       z = (#green - γT) / sqrt(T·γ(1-γ))
 *
 *   Tournament: each g-value is a fair coin, so
 *       z = (mean - 0.5) · 2 · sqrt(T·m)
 *
 * Large z means far more green or high-g tokens than chance allows. The papers treat
 * z >= 4 as a detection (one-sided p about 3e-5). The wrong key yields z near 0,
 * because the rebuilt lists do not match the ones used at write time.
 *
 * Two extra rules from the papers:
 *  • Skip the first h tokens (no full context).
 *  • If `ignoreRepeats` is on, count a repeated (context, token) pair only once, so a
 *    looping phrase cannot inflate z.
 *
 * Terms: see the glossary in `src/main.tsx`.
 */

import { hashString } from './hash';
import { isGreen, seedForPosition } from './greenlist';
import { gValue } from './tournament';
import type { WatermarkParams } from './params';

/** Which statistical test to run. Chosen from the generation mode by `schemeFor`. */
export type DetectionScheme = 'greenlist' | 'tournament';

export function schemeFor(mode: WatermarkParams['mode']): DetectionScheme {
  return mode === 'tournament' ? 'tournament' : 'greenlist';
}

export interface TokenScore {
  /** Position in the detector's token sequence. */
  index: number;
  tokenId: number;
  /** false for the first h tokens (no context) and for de-duplicated repeats. */
  scored: boolean;
  /** Green-list scheme: 1 = green, 0 = red. Tournament: mean g-value in [0, 1]. */
  score: number;
  /**
   * Tournament only: the individual g_ℓ(x_t) for ℓ = 0 .. m-1 that `score` averages.
   * The UI draws these as the m-cell grid above each token (green = 1, red = 0).
   * That is the picture from the SynthID paper. Watermarked text has more green cells.
   */
  gValues?: (0 | 1)[];
}

export interface DetectionResult {
  scheme: DetectionScheme;
  /** Number of tokens that contributed to the statistic. */
  numScored: number;
  /** Green-list: number of green tokens. Tournament: sum of mean g-values (a "soft" count). */
  statistic: number;
  /** Observed green fraction / mean g-value. */
  observedRate: number;
  /** Expected rate under H0: γ for the green list, 0.5 for the tournament. */
  expectedRate: number;
  zScore: number;
  /** One-sided p-value P(Z >= z) under H0. */
  pValue: number;
  perToken: TokenScore[];
  /**
   * Echo of the settings this result was computed with. The UI shows them next to the
   * verdict ("green list, γ=0.5, h=4"). A result stays readable after the user
   * changes the sliders on the left.
   */
  params: DetectionOptions['params'];
  ignoreRepeats: boolean;
}

export interface DetectionOptions {
  key: string;
  params: Pick<WatermarkParams, 'mode' | 'gamma' | 'h' | 'depth'>;
  ignoreRepeats: boolean;
}

/**
 * Score a token sequence. Pure function: same inputs give the same result.
 * The UI can re-run it at once when the user edits the text or changes the key.
 */
export function detect(tokens: ArrayLike<number>, options: DetectionOptions): DetectionResult {
  const { key, params, ignoreRepeats } = options;
  const scheme = schemeFor(params.mode);
  const keyHash = hashString(key);
  const h = params.h;

  const perToken: TokenScore[] = [];
  const seen = new Set<string>();
  let numScored = 0;
  let statistic = 0;

  for (let i = 0; i < tokens.length; i++) {
    const tokenId = tokens[i];
    const seed = seedForPosition(keyHash, tokens, i, h);

    // No complete context window: cannot recompute the list. Leave unscored.
    if (seed === null) {
      perToken.push({ index: i, tokenId, scored: false, score: 0 });
      continue;
    }

    // The score depends only on (seed, token). Two positions with identical
    // (previous h tokens, token) produce identical evidence. Count it once.
    // Repeats are still scored for display. They are excluded from the statistic.
    const { score, gValues } = scoreOf(scheme, seed, tokenId, params);
    if (ignoreRepeats) {
      const ngramKey = `${seed}:${tokenId}`;
      if (seen.has(ngramKey)) {
        perToken.push({ index: i, tokenId, scored: false, score, gValues });
        continue;
      }
      seen.add(ngramKey);
    }

    perToken.push({ index: i, tokenId, scored: true, score, gValues });
    numScored++;
    statistic += score;
  }

  const expectedRate = scheme === 'greenlist' ? params.gamma : 0.5;
  const observedRate = numScored > 0 ? statistic / numScored : 0;

  let zScore = 0;
  if (numScored > 0) {
    if (scheme === 'greenlist') {
      // Binomial(T, γ) normal approximation.
      const T = numScored;
      const g = params.gamma;
      zScore = (statistic - g * T) / Math.sqrt(T * g * (1 - g));
    } else {
      // Mean of T·m fair coins: sd = ½ / sqrt(T·m).
      const n = numScored * params.depth;
      zScore = (observedRate - 0.5) * 2 * Math.sqrt(n);
    }
  }

  return {
    scheme,
    numScored,
    statistic,
    observedRate,
    expectedRate,
    zScore,
    pValue: oneSidedPValue(zScore),
    perToken,
    params: { mode: params.mode, gamma: params.gamma, h: params.h, depth: params.depth },
    ignoreRepeats,
  };
}

/**
 * Per-position evidence.
 *   green list:  1 if the token is on this context's green list, else 0.
 *   tournament:  the m layer values g_ℓ(x_t) and their mean - the inner sum of
 *                score = 1/(mT) · Σ_t Σ_ℓ g_ℓ(x_t) from the SynthID paper.
 */
function scoreOf(
  scheme: DetectionScheme,
  seed: number,
  tokenId: number,
  params: DetectionOptions['params'],
): { score: number; gValues?: (0 | 1)[] } {
  if (scheme === 'greenlist') return { score: isGreen(seed, tokenId, params.gamma) ? 1 : 0 };

  const gValues: (0 | 1)[] = [];
  let sum = 0;
  for (let layer = 0; layer < params.depth; layer++) {
    const g = gValue(seed, tokenId, layer);
    gValues.push(g);
    sum += g;
  }
  return { score: sum / params.depth, gValues };
}

/**
 * P(Z >= z) for a standard normal, via the complementary error function:
 * 1 - Φ(z) = 1/2 · erfc(z/√2). Uses the Chebyshev-fitted approximation from
 * Numerical Recipes (`erfcc`). Relative error is about 1.2e-7.
 * That is enough to print p-values like 3.2e-5.
 * Direct `1 - Φ(z)` would lose precision for large z.
 */
export function oneSidedPValue(z: number): number {
  const x = z / Math.SQRT2;
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const poly =
    -x * x -
    1.26551223 +
    t *
      (1.00002368 +
        t *
          (0.37409196 +
            t *
              (0.09678418 +
                t *
                  (-0.18628806 +
                    t *
                      (0.27886807 +
                        t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
  const erfcAbs = t * Math.exp(poly);
  const erfc = x >= 0 ? erfcAbs : 2 - erfcAbs;
  return 0.5 * erfc;
}

/** The two decision thresholds used throughout the UI. */
export const Z_DETECT = 4; // papers' operating point: one-sided p about 3e-5
export const Z_WEAK = 2; // p about 0.023. Suggestive, not conclusive.

export type VerdictLevel = 'strong' | 'weak' | 'none';

/** Human-readable verdict for the UI, using the conventional z = 4 threshold. */
export function verdictFor(z: number): { label: string; level: VerdictLevel } {
  if (z >= Z_DETECT) return { label: 'Watermark detected', level: 'strong' };
  if (z >= Z_WEAK) return { label: 'Weak evidence of a watermark', level: 'weak' };
  return { label: 'No watermark detected', level: 'none' };
}

/**
 * "Confidence" in the UI is 1 - p.
 * That is the chance that plain text would not score this high.
 * 98.3% means p = 0.017.
 * This is a statement about H0. It is not the probability that the text is watermarked.
 */
export function confidenceFor(pValue: number): number {
  return Math.max(0, Math.min(1, 1 - pValue));
}

/** Short description of the test that was run, for example "green list (γ=0.5, h=4)". */
export function describeDetector(r: DetectionResult): string {
  const p = r.params;
  return r.scheme === 'greenlist' ? `green list (γ=${p.gamma}, h=${p.h})` : `tournament (m=${p.depth}, h=${p.h})`;
}

/**
 * One paragraph of context for the verdict, matched to the result and the scheme.
 * Written for a reader who is learning how the schemes behave.
 * It names the knob that would change the outcome.
 */
export function explainResult(r: DetectionResult): string {
  const { level } = verdictFor(r.zScore);
  const mode = r.params.mode;
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  if (r.numScored < 8) {
    return `Only ${r.numScored} tokens were scored. That is too few for the z-test. Generate a longer text.`;
  }

  if (level === 'strong') {
    const what = r.scheme === 'greenlist' ? `${pct(r.observedRate)} of tokens are green vs ${pct(r.expectedRate)} expected by chance` : `mean g-value ${r.observedRate.toFixed(3)} vs 0.5 by chance`;
    return `${what}. Under the no-watermark hypothesis a z-score this large occurs with probability ${r.pValue < 1e-4 ? r.pValue.toExponential(1) : r.pValue.toFixed(4)}. Change the detector key. Or edit the text. Watch the signal drop.`;
  }

  if (level === 'weak') {
    // z grows like √T. A strong per-token signal with few tokens still cannot
    // reach 4 (24 all-green tokens at γ=0.8 give z about 2.4). Say so before blaming the scheme.
    if (r.numScored < 40 && r.observedRate > r.expectedRate + 0.1) {
      const what = r.scheme === 'greenlist' ? `${pct(r.observedRate)} green (vs ${pct(r.expectedRate)} by chance)` : `mean g-value ${r.observedRate.toFixed(2)}`;
      return `${what}, but only ${r.numScored} tokens were scored. The z-score grows with √T. A short text cannot reach z >= ${Z_DETECT} even when it is well watermarked. Generate a longer output. Raise max tokens.`;
    }
    const knob =
      mode === 'soft'
        ? 'Longer outputs or a larger δ strengthen the signal. δ only tips low-confidence positions. Highly predictable text carries little watermark.'
        : mode === 'tournament'
          ? 'Longer outputs or more tournament layers (depth m) strengthen the signal. Low-entropy text is hard to watermark by any scheme.'
          : mode === 'hard'
            ? 'Hard mode normally gives a strong signal. A weak one means tokenisation drift or edits broke many positions. Try the oracle option (re-tokenise off).'
            : 'Above chance, but this can happen about 2% of the time with un-watermarked text. Nothing was embedded in mode None.';
    return `Above chance, but below the paper's z >= ${Z_DETECT} threshold. ${knob}`;
  }

  // level === 'none'
  if (mode === 'none') {
    return 'No watermark was embedded (mode None). A z-score near zero is the expected control result. The detector sees the green-list rate a plain model produces by chance.';
  }
  return 'This matches un-watermarked text, or a wrong detector key, or mismatched γ/h/depth, or heavy editing. Check that the detector key matches the generation key.';
}
