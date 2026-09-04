/**
 * Parameter types shared by the UI, the generation worker and the detector.
 *
 * Everything here is plain data (no classes, no functions) so it can be sent
 * through `postMessage` to the Web Worker unchanged.
 *
 * If you do not know LLM terms yet, read the glossary at the top of `src/main.tsx`.
 * Short versions used in this file:
 *   token     = a word or word-piece the model picks
 *   logits    = raw scores for every possible next token
 *   green/red = the two groups a watermark splits the vocabulary into
 *   key       = the secret both generator and detector must share
 */

/**
 * Which watermarking scheme is applied while sampling each token.
 *
 * - `none`        Plain sampling. Useful as a control: detection should report z ≈ 0.
 * - `hard`        Kirchenbauer et al. (2023) "hard red list": red-list tokens are
 *                 forbidden outright (logit → -∞). Very detectable, but can hurt
 *                 quality when the only sensible next token is red.
 * - `soft`        Kirchenbauer et al. "soft red list": green-list logits get +δ.
 *                 Low-entropy positions (one obvious next token) are left almost
 *                 unchanged, high-entropy positions get nudged toward green.
 * - `tournament`  Dathathri et al. (2024, "SynthID-Text"): sample candidates and
 *                 run them through `depth` rounds of a hash-keyed tournament.
 *                 Distortion-free per step in expectation; detected via mean g-value.
 */
export type WatermarkMode = 'none' | 'hard' | 'soft' | 'tournament';

export interface WatermarkParams {
  mode: WatermarkMode;
  /**
   * γ — fraction of the vocabulary placed on the green list at each step.
   * Only used by `hard` and `soft`. Default 0.5 in the paper; 0.25 is also common.
   */
  gamma: number;
  /**
   * δ — logit bias added to green-list tokens (soft mode only). Larger δ means a
   * stronger, more detectable watermark at the cost of more distortion. 2–4 is typical.
   */
  delta: number;
  /**
   * h — how many *previous* tokens are hashed together with the key to seed the
   * green list (or the tournament g-functions) for the current position.
   *
   * h=1 is the original paper's scheme (robust to edits, but repeated bigrams leak
   * structure). Larger h gives more "random-looking" lists but makes detection more
   * fragile: a single edited token corrupts h subsequent scores.
   * SynthID-Text uses h=4 by default (their "ngram_len=5" ⇒ 4 context tokens).
   */
  h: number;
  /** Secret key. Anyone holding the key can detect; without it the text looks normal. */
  key: string;
  /**
   * Tournament depth m (tournament mode only). Number of tournament layers.
   * SynthID-Text's default is 30. Each layer has its own derived key.
   */
  depth: number;
  /**
   * Playground aid: words whose tokens are forced onto the red list every step.
   * In `hard` mode they can never be generated; in `soft` mode they are discouraged.
   * Comma separated in the UI; split into words before use.
   */
  forceRedWords: string[];
}

export interface GenerationParams {
  maxNewTokens: number;
  /** Softmax temperature. 0 would be greedy; we clamp to a small positive value. */
  temperature: number;
  /** Keep only the k most likely tokens (0 disables). Applied after temperature. */
  topK: number;
  /** Nucleus sampling: keep the smallest set of tokens whose probability sums to ≥ p (1 disables). */
  topP: number;
  /** HF-style repetition penalty (1 disables). Applied by Transformers.js before our processor. */
  repetitionPenalty: number;
  /**
   * Seed for the *sampling* RNG (not the watermark key!). Empty string = fresh
   * randomness every run. Set it to reproduce a run exactly.
   */
  seed: string;
}

/**
 * How the prompt is fed to the model.
 * - `instruction`  Wrap the prompt in the model's chat template so it answers as an assistant.
 * - `continuation` Feed raw text; the model keeps writing where the text stops.
 */
export type PromptMode = 'instruction' | 'continuation';

export const DEFAULT_WATERMARK: WatermarkParams = {
  mode: 'soft',
  gamma: 0.5,
  delta: 4,
  h: 4,
  key: 'ai_wrote_this',
  depth: 30,
  forceRedWords: [],
};

export const DEFAULT_GENERATION: GenerationParams = {
  maxNewTokens: 160,
  temperature: 1.0,
  topK: 50,
  topP: 0.95,
  repetitionPenalty: 1.1,
  seed: '',
};

/** Split the UI's comma separated "force red" text box into clean words. */
export function parseWordList(text: string): string[] {
  return text
    .split(',')
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}
