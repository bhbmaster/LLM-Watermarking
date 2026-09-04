/**
 * `WatermarkLogitsProcessor` — where the watermark meets Transformers.js.
 *
 * Transformers.js is the library that runs the language model in the browser.
 * `model.generate()` is its write loop. Each round it:
 *
 *   1. runs the neural net (the "forward pass") and gets logits = a score per token;
 *   2. lets every LogitsProcessor change those scores (this class is one of them);
 *   3. picks a token (the sampler);
 *   4. appends that token to the text and repeats.
 *
 * Built-in processors (for example repetition penalty) run first. Ours runs last.
 *
 * A LogitsProcessor is only allowed to change scores. It cannot say "pick token 4711."
 * We still need to pick the token ourselves: Transformers.js has no top-k/top-p, and
 * tournament watermarking must sample, not only re-weight. So this class:
 *
 *   1. runs the full watermark + sampling pipeline inside `_call` and chooses a token;
 *   2. writes -Infinity on every logit except 0 at the chosen token;
 *   3. asks `generate()` to use greedy pick (`do_sample: false`), so it must take ours.
 *
 * Because we already know the chosen token, `onStep` can send a trace to the UI
 * (probability, entropy, green/red or mean g-value) for the hover tooltip.
 *
 * Terms: see the glossary in `src/main.tsx`.
 */

import { LogitsProcessor, type Tensor } from '@huggingface/transformers';
import { hashString, makeRng } from './hash';
import { applyHardRedList, applySoftRedList, isGreen, seedForNext } from './greenlist';
import { applyTournament, meanGValue } from './tournament';
import { entropyBits, sampleFrom, softmaxWithTemperature, truncate } from './sampling';
import type { GenerationParams, WatermarkParams } from './params';

/** Per-token diagnostics emitted for the UI (all computed at sampling time). */
export interface StepTrace {
  /** 0-based index of this token among the *generated* tokens. */
  step: number;
  tokenId: number;
  /** Model probability of the chosen token *after* watermarking and truncation. */
  prob: number;
  /** Entropy (bits) of the truncated distribution the token was drawn from. */
  entropyBits: number;
  /** How many tokens survived top-k / top-p at this step. */
  numCandidates: number;
  /** Red/green schemes: was the chosen token on the green list? */
  green?: boolean;
  /** Tournament scheme: mean g-value of the chosen token over all layers. */
  meanG?: number;
}

export interface WatermarkProcessorOptions {
  watermark: WatermarkParams;
  generation: GenerationParams;
  /** Token ids that end generation; exempt from red-listing so the model can stop. */
  eosTokenIds: number[];
  /** Mask (indexed by token id) of tokens forced onto the red list, or null. */
  forcedRed: Uint8Array | null;
  /** Called after every token is chosen. */
  onStep?: (trace: StepTrace) => void;
}

export class WatermarkLogitsProcessor extends LogitsProcessor {
  private readonly wm: WatermarkParams;
  private readonly gen: GenerationParams;
  private readonly keyHash: number;
  private readonly exempt: Set<number>;
  private readonly forcedRed: Uint8Array | null;
  private readonly rng: () => number;
  private readonly onStep?: (trace: StepTrace) => void;
  private step = 0;

  constructor(o: WatermarkProcessorOptions) {
    super();
    this.wm = o.watermark;
    this.gen = o.generation;
    this.keyHash = hashString(o.watermark.key);
    this.exempt = new Set(o.eosTokenIds);
    this.forcedRed = o.forcedRed;
    this.rng = makeRng(o.generation.seed);
    this.onStep = o.onStep;
  }

  /**
   * @param inputIds  full sequence so far (prompt + generated), one array per batch row.
   *                  Transformers.js gives BigInts because the model's ids are int64.
   * @param logits    Tensor of shape [batch, vocab]; we support batch size 1.
   */
  override _call(inputIds: bigint[][], logits: Tensor): Tensor {
    if (inputIds.length !== 1) throw new Error('WatermarkLogitsProcessor supports batch size 1 only');
    const data = logits.data as Float32Array;
    const wm = this.wm;

    // Only the last h tokens matter for the seed; convert just those from BigInt.
    const seq = inputIds[0];
    const ctxLen = Math.min(wm.h, seq.length);
    const context = new Array<number>(ctxLen);
    for (let i = 0; i < ctxLen; i++) context[i] = Number(seq[seq.length - ctxLen + i]);
    const seed = seedForNext(this.keyHash, context, wm.h);

    // ── 1. Red/green bias on raw logits (before temperature, as in the paper) ──
    const listOpts = { seed, gamma: wm.gamma, forcedRed: this.forcedRed, exempt: this.exempt };
    if (wm.mode === 'hard') applyHardRedList(data, listOpts);
    else if (wm.mode === 'soft') applySoftRedList(data, wm.delta, listOpts);

    // ── 2. Ordinary sampling pipeline: temperature → softmax → top-k → top-p ──
    const probs = softmaxWithTemperature(data, this.gen.temperature);
    const dist = truncate(probs, this.gen.topK, this.gen.topP);

    // ── 3. Tournament re-weighting operates on the truncated distribution ──
    if (wm.mode === 'tournament') applyTournament(dist, seed, wm.depth);

    // ── 4. Draw the token ──
    const tokenId = sampleFrom(dist, this.rng);

    // ── 5. Report, then collapse the logits so greedy decoding must pick our token ──
    this.onStep?.({
      step: this.step++,
      tokenId,
      prob: dist.probs[tokenId],
      entropyBits: entropyBits(dist),
      numCandidates: dist.candidates.length,
      ...(wm.mode === 'hard' || wm.mode === 'soft'
        ? { green: this.exempt.has(tokenId) ? undefined : isGreen(seed, tokenId, wm.gamma) }
        : {}),
      ...(wm.mode === 'tournament' ? { meanG: meanGValue(seed, tokenId, wm.depth) } : {}),
    });

    data.fill(-Infinity);
    data[tokenId] = 0;
    return logits;
  }
}
