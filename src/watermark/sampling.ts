/**
 * Ordinary sampling: how the model picks the next token when no watermark (or after
 * the watermark has already changed the scores).
 *
 * The model first outputs a score for every token (logits). This file turns those
 * scores into a lottery, then draws one ticket:
 *
 *   logits → divide by temperature → softmax (now probabilities) → keep top-k
 *         → keep top-p (nucleus) → draw one token at random
 *
 * We implement this here because Transformers.js v4 does not ship top-k / top-p.
 * The tournament watermark must draw a token itself. See `processor.ts` for the
 * full pipeline.
 *
 * `probs` is indexed by token id. A `Distribution` is a shortened list: only the
 * surviving candidates, sorted most-likely first, probabilities summing to 1.
 */

export interface Distribution {
  /** Probability per token id; zero for tokens that were truncated away. */
  probs: Float32Array;
  /** Token ids that survived truncation, sorted by decreasing probability. */
  candidates: Uint32Array;
}

/** Smallest temperature we allow; T=0 would divide by zero (and means "greedy"). */
const MIN_TEMPERATURE = 1e-3;

/**
 * softmax(logits / T) with the usual max-subtraction for numerical stability.
 * `-Infinity` logits (for example hard-red-listed tokens) become exactly 0 probability.
 */
export function softmaxWithTemperature(logits: Float32Array, temperature: number): Float32Array {
  const T = Math.max(temperature, MIN_TEMPERATURE);
  const n = logits.length;
  const probs = new Float32Array(n);

  let max = -Infinity;
  for (let i = 0; i < n; i++) if (logits[i] > max) max = logits[i];

  let sum = 0;
  for (let i = 0; i < n; i++) {
    // exp(-Infinity) === 0, so masked tokens drop out naturally.
    const e = Math.exp((logits[i] - max) / T);
    probs[i] = e;
    sum += e;
  }
  const inv = 1 / sum;
  for (let i = 0; i < n; i++) probs[i] *= inv;
  return probs;
}

/**
 * Indices of the `k` largest values in `values`, in no particular order.
 * Uses a size-k min-heap: O(V log k) instead of sorting the whole vocabulary (V about 150k).
 * The heap root is always the smallest kept value. A new value only enters if it
 * beats the root. Almost every token fails that test after the first few thousand.
 */
function topKIndices(values: Float32Array, k: number): Uint32Array {
  const heapV = new Float32Array(k);
  const heapI = new Uint32Array(k);
  let size = 0;

  const siftDown = (pos: number) => {
    for (;;) {
      const l = 2 * pos + 1;
      const r = l + 1;
      let smallest = pos;
      if (l < size && heapV[l] < heapV[smallest]) smallest = l;
      if (r < size && heapV[r] < heapV[smallest]) smallest = r;
      if (smallest === pos) return;
      [heapV[pos], heapV[smallest]] = [heapV[smallest], heapV[pos]];
      [heapI[pos], heapI[smallest]] = [heapI[smallest], heapI[pos]];
      pos = smallest;
    }
  };

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (size < k) {
      // Heap not full yet: append and bubble up.
      let pos = size++;
      heapV[pos] = v;
      heapI[pos] = i;
      while (pos > 0) {
        const parent = (pos - 1) >> 1;
        if (heapV[parent] <= heapV[pos]) break;
        [heapV[pos], heapV[parent]] = [heapV[parent], heapV[pos]];
        [heapI[pos], heapI[parent]] = [heapI[parent], heapI[pos]];
        pos = parent;
      }
    } else if (v > heapV[0]) {
      // Beats the smallest kept value: replace the root and restore heap order.
      heapV[0] = v;
      heapI[0] = i;
      siftDown(0);
    }
  }
  return heapI.subarray(0, size);
}

/**
 * Apply top-k then top-p (nucleus) truncation and renormalise.
 *
 * @param probs  full-vocabulary probabilities (will NOT be modified; a copy is returned)
 * @param topK   keep the k most likely tokens; 0 = disabled
 * @param topP   keep the smallest prefix (in probability order) whose mass >= p; 1 = disabled
 */
export function truncate(probs: Float32Array, topK: number, topP: number): Distribution {
  const V = probs.length;

  // 1. Candidate set: top-k if requested, otherwise every token with non-zero mass.
  let candidates: Uint32Array;
  if (topK > 0 && topK < V) {
    candidates = topKIndices(probs, topK);
  } else {
    let count = 0;
    for (let i = 0; i < V; i++) if (probs[i] > 0) count++;
    candidates = new Uint32Array(count);
    for (let i = 0, j = 0; i < V; i++) if (probs[i] > 0) candidates[j++] = i;
  }

  // 2. Sort candidates by decreasing probability (needed for nucleus sampling).
  //    Sorting the full vocabulary here (top-k disabled) costs ~tens of ms per token.
  candidates.sort((a, b) => probs[b] - probs[a]);

  // 3. Nucleus cut-off: walk the sorted list until cumulative mass reaches p.
  if (topP < 1) {
    let cum = 0;
    let keep = 0;
    while (keep < candidates.length) {
      cum += probs[candidates[keep]];
      keep++;
      if (cum >= topP) break;
    }
    candidates = candidates.subarray(0, keep);
  }

  // 4. Renormalise over survivors into a fresh array (zero elsewhere).
  const out = new Float32Array(V);
  let mass = 0;
  for (let i = 0; i < candidates.length; i++) mass += probs[candidates[i]];
  const inv = 1 / mass;
  for (let i = 0; i < candidates.length; i++) {
    const id = candidates[i];
    out[id] = probs[id] * inv;
  }
  return { probs: out, candidates };
}

/** Draw one token id from a distribution using inverse-CDF sampling with `rng() ∈ [0,1)`. */
export function sampleFrom(dist: Distribution, rng: () => number): number {
  const { probs, candidates } = dist;
  const r = rng();
  let cum = 0;
  for (let i = 0; i < candidates.length; i++) {
    cum += probs[candidates[i]];
    if (r < cum) return candidates[i];
  }
  // Floating-point round-off can leave cum slightly below 1; fall back to the last candidate.
  return candidates[candidates.length - 1];
}

/**
 * Shannon entropy of the (truncated) distribution in bits. Shown in the UI per token.
 * Watermarks can only hide information at positions where the model is uncertain.
 * High-entropy tokens are where the green list or tournament actually bite.
 */
export function entropyBits(dist: Distribution): number {
  let H = 0;
  for (let i = 0; i < dist.candidates.length; i++) {
    const p = dist.probs[dist.candidates[i]];
    if (p > 0) H -= p * Math.log2(p);
  }
  return H;
}
