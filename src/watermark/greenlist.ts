/**
 * Red/green list watermark — Kirchenbauer, Geiping, Wen, Katz, Miers, Goldstein,
 * "A Watermark for Large Language Models" (ICML 2023).
 *
 * Plain-language idea: before each next word, a secret key plus the last few words
 * split the model's vocabulary into a preferred group (green) and an avoided group
 * (red). A watermarked model picks green far more often than chance. A detector that
 * knows the key rebuilds the same groups from the text and counts green hits.
 *
 * The scheme, one token at a time:
 *
 *   1. Look at the previous h tokens and hash them with the secret key → a seed.
 *   2. Use the seed to split the vocabulary into a GREEN list (fraction γ) and a
 *      RED list (fraction 1-γ). Every position gets a different, unpredictable split.
 *   3. Hard variant: forbid red tokens (logit → -∞).
 *      Soft variant: add δ to the logits of green tokens, then sample as usual.
 *   4. The detector recomputes the same lists from the text and counts how many of
 *      the T tokens landed on green. Un-watermarked text hits green ≈ γ·T times by
 *      chance; watermarked text hits it far more often. See `detect.ts` for the z-test.
 *
 * Implementation note — how we build the green list. The paper draws a random
 * *permutation* of the vocabulary and takes the first γ|V| entries. That guarantees
 * exactly γ|V| green tokens but costs O(|V|) memory/time per step for the shuffle.
 * We use the widely-used equivalent: each token is green iff a keyed hash of
 * (seed, token) falls below γ. Each token is green with probability γ independently,
 * so the list size is γ|V| only on average — but the detector statistics (expected
 * green fraction γ under the null hypothesis) are identical, and membership of a
 * single token can be checked in O(1), which is what detection needs.
 */

import { hashContext, hashToken, toUnit } from './hash';

/**
 * Seed used to draw the green list for the token at index `position` in `tokens`.
 * Returns `null` when fewer than h tokens precede the position — those tokens cannot
 * be scored by a detector that only sees the text (it doesn't know the prompt).
 */
export function seedForPosition(
  keyHash: number,
  tokens: ArrayLike<number>,
  position: number,
  h: number,
): number | null {
  if (position < h) return null;
  const ctx = new Array<number>(h);
  for (let i = 0; i < h; i++) ctx[i] = tokens[position - h + i];
  return hashContext(keyHash, ctx);
}

/** Seed for the *next* token given the full sequence so far (generation-side helper). */
export function seedForNext(keyHash: number, tokens: ArrayLike<number>, h: number): number {
  const n = tokens.length;
  const ctx = new Array<number>(h);
  for (let i = 0; i < h; i++) {
    const idx = n - h + i;
    // If the prompt is shorter than h (rare: only when using continuation with a tiny
    // prompt), pad with -1 so the context always has exactly h entries.
    ctx[i] = idx >= 0 ? tokens[idx] : 0xffffffff;
  }
  return hashContext(keyHash, ctx);
}

/** Is `tokenId` on the green list for this seed? Uniform hash < γ ⇒ green. */
export function isGreen(seed: number, tokenId: number, gamma: number): boolean {
  return toUnit(hashToken(seed, tokenId)) < gamma;
}

export interface GreenListOptions {
  seed: number;
  gamma: number;
  /**
   * Token ids that must always count as red (the UI's "force onto the red list").
   * A `Uint8Array` mask indexed by token id, or `null` for none.
   */
  forcedRed: Uint8Array | null;
  /**
   * Token ids exempt from the watermark. We exempt end-of-sequence tokens so a hard
   * red list can never make the model *unable to stop* (which would otherwise happen
   * ~(1-γ) of the time at the natural end of an answer).
   */
  exempt: Set<number>;
}

/**
 * HARD red list: set red-listed logits to -∞ so they can never be sampled.
 * Modifies `logits` in place.
 */
export function applyHardRedList(logits: Float32Array, o: GreenListOptions): void {
  for (let id = 0; id < logits.length; id++) {
    if (o.exempt.has(id)) continue;
    const red = (o.forcedRed !== null && o.forcedRed[id] === 1) || !isGreen(o.seed, id, o.gamma);
    if (red) logits[id] = -Infinity;
  }
}

/**
 * SOFT red list: add δ to every green-listed logit. Red tokens are untouched, so at a
 * low-entropy position (one token with logit ≫ the rest) a red top choice still wins —
 * that's the whole point: the soft watermark barely distorts confident predictions and
 * embeds itself where the model was undecided anyway. Modifies `logits` in place.
 */
export function applySoftRedList(logits: Float32Array, delta: number, o: GreenListOptions): void {
  for (let id = 0; id < logits.length; id++) {
    if (o.exempt.has(id)) continue;
    if (o.forcedRed !== null && o.forcedRed[id] === 1) continue;
    if (isGreen(o.seed, id, o.gamma)) logits[id] += delta;
  }
}
