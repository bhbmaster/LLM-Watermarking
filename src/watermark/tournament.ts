/**
 * Tournament sampling — Dathathri et al., "Scalable watermarking for identifying large
 * language model outputs" (Nature, 2024). Google ships this as SynthID-Text.
 *
 * Plain-language idea: do not forbid words. Draw many candidate next-tokens from the
 * model, then run a knock-out contest. Each round uses a secret keyed coin-flip
 * g(token) = 0 or 1. The candidate with the better coin wins. After many rounds, one
 * token remains. A detector who knows the key averages those coin-flips over the
 * whole text. Chance is 0.5. Watermarked text sits above 0.5.
 *
 * ── The bracket ────────────────────────────────────────────────────────────────────
 * Instead of biasing logits, we *sample* several candidate tokens from the model's own
 * distribution and let them fight in a knock-out tournament:
 *
 *   • For each layer ℓ = 1..m the key + context seed a "g-function"
 *         g_ℓ(token) ∈ {0, 1}         (a keyed pseudo-random coin per token per layer)
 *   • Draw 2^m candidates i.i.d. from the model distribution p.
 *   • Layer 1: pair them up; in each pair the token with the larger g_1 wins
 *     (ties → pick one at random). Layer 2: pair the winners, compare g_2, ... until one
 *     token remains after m layers. That token is emitted.
 *
 * Because *every* candidate came from p, the output distribution is p re-weighted
 * toward tokens that are "lucky" under the g-functions. A detector recomputes the
 * g-values of the text it sees: watermarked text has a mean g-value noticeably above
 * the 0.5 you'd get by chance (see `detect.ts`).
 *
 * Why is this "distortion-free"? Averaged over the random key, each token is emitted
 * with exactly its model probability p(token) — the key only decides *which* tokens
 * get boosted, and the boosts cancel in expectation. (Kirchenbauer's soft list is not
 * distortion-free: green tokens are favoured regardless of the key's randomness.)
 *
 * ── Efficient equivalent: one layer at a time in closed form ───────────────────────
 * Simulating 2^30 candidates is impossible, but we never need to: with i.i.d. candidates
 * a single layer maps distribution p to p' analytically. Let q = Σ_x p(x)·g(x) be the
 * probability mass of "g=1" tokens. For a pair (X, Y) drawn from p, X wins the match if
 * g(X) > g(Y), or with prob ½ if g(X) = g(Y). So
 *
 *      P(winner = x) = 2·p(x)·[ P(g(Y) < g(x)) + ½·P(g(Y) = g(x)) ]
 *
 *      g(x) = 1 :  2·p(x)·[ (1-q) + ½·q ]  =  p(x)·(2 - q)        (boosted)
 *      g(x) = 0 :  2·p(x)·[    0    + ½·(1-q) ]  =  p(x)·(1 - q)  (suppressed)
 *
 * (Check: Σ = q(2-q) + (1-q)(1-q) = 1 ✓.) Winners of layer 1 are i.i.d. draws from p',
 * so layer 2 applies the same formula to p' with g_2, and so on. After m layers we draw
 * *one* token from p_m — exactly the tournament winner's distribution. This is also how
 * the reference implementation in 🤗 transformers (`SynthIDTextWatermarkLogitsProcessor`)
 * does it. `tournamentBracketSample` below is the literal bracket, kept as a readable
 * reference and as a test oracle for `applyTournament`.
 */

import { hashToken } from './hash';
import type { Distribution } from './sampling';
import { sampleFrom } from './sampling';

/**
 * g_ℓ(token): the layer-ℓ pseudo-random bit for a token under this context seed.
 * We take the top bit of a fresh hash (salted by layer) so each layer is independent.
 */
export function gValue(seed: number, tokenId: number, layer: number): 0 | 1 {
  return (hashToken(seed, tokenId, layer) >>> 31) as 0 | 1;
}

/**
 * Re-weight a (truncated, normalised) distribution through `depth` tournament layers,
 * in place, using the closed form derived above. After this call, `sampleFrom(dist)`
 * draws exactly what a 2^depth-candidate tournament would have emitted.
 *
 * Cost is O(depth × |candidates|): after top-k/top-p that is tiny.
 */
export function applyTournament(dist: Distribution, seed: number, depth: number): void {
  const { probs, candidates } = dist;
  const n = candidates.length;
  if (n <= 1) return; // nothing to choose between — the watermark can't embed anything here

  // Scratch buffer for this layer's g-values so we hash each candidate once per layer.
  const g = new Uint8Array(n);

  for (let layer = 0; layer < depth; layer++) {
    // q = probability mass currently on g=1 tokens.
    let q = 0;
    for (let i = 0; i < n; i++) {
      const id = candidates[i];
      g[i] = gValue(seed, id, layer);
      if (g[i] === 1) q += probs[id];
    }
    // p'(x) = p(x)·(2-q) if g(x)=1, p(x)·(1-q) otherwise. Total mass stays 1.
    const boost = 2 - q;
    const damp = 1 - q;
    for (let i = 0; i < n; i++) {
      const id = candidates[i];
      probs[id] *= g[i] === 1 ? boost : damp;
    }
  }

  // Guard against floating-point drift after many layers.
  let mass = 0;
  for (let i = 0; i < n; i++) mass += probs[candidates[i]];
  const inv = 1 / mass;
  for (let i = 0; i < n; i++) probs[candidates[i]] *= inv;

  // Keep the "sorted by decreasing probability" invariant of `Distribution`.
  candidates.sort((a, b) => probs[b] - probs[a]);
}

/**
 * The literal bracket: sample 2^depth candidates and run the knock-out tournament.
 * Exponential in depth, so only sensible for depth ≲ 10. It exists to make the
 * algorithm concrete and to cross-check `applyTournament` (their output distributions
 * must agree). Not used in the app's hot path.
 */
export function tournamentBracketSample(
  dist: Distribution,
  seed: number,
  depth: number,
  rng: () => number,
): number {
  let round: number[] = [];
  const count = 1 << depth;
  for (let i = 0; i < count; i++) round.push(sampleFrom(dist, rng));

  for (let layer = 0; layer < depth; layer++) {
    const next: number[] = [];
    for (let i = 0; i < round.length; i += 2) {
      const a = round[i];
      const b = round[i + 1];
      const ga = gValue(seed, a, layer);
      const gb = gValue(seed, b, layer);
      if (ga > gb) next.push(a);
      else if (gb > ga) next.push(b);
      else next.push(rng() < 0.5 ? a : b); // tie: coin flip
    }
    round = next;
  }
  return round[0];
}

/**
 * Mean g-value of a token over all layers — the per-token detection score for this
 * scheme. Under no watermark each g is a fair coin, so the expectation is 0.5.
 */
export function meanGValue(seed: number, tokenId: number, depth: number): number {
  let sum = 0;
  for (let layer = 0; layer < depth; layer++) sum += gValue(seed, tokenId, layer);
  return sum / depth;
}
