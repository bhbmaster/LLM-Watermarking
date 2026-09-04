/**
 * Hashing used by every watermark in this app.
 *
 * Both schemes need a repeatable "random" number from:
 *   the secret key + the last few tokens (+ sometimes the candidate token).
 * The generator uses that number to bias the next pick. The detector, who also
 * knows the key, computes the same number from the text alone. Without the key
 * the numbers look random, so a reader sees no pattern.
 *
 * This file is not cryptography. It is a small 32-bit hash, enough for a
 * playground. A production detector would use a keyed function such as HMAC.
 *
 * Three steps:
 *   1. `hashString`  — turn the key text into one 32-bit integer
 *   2. `hashContext` — mix in the previous token ids
 *   3. `mix32`       — scramble an integer so it looks uniform
 *
 * `>>> 0` keeps JavaScript numbers in unsigned 32-bit range. `Math.imul` multiplies
 * with 32-bit wraparound.
 */

/** FNV-1a: a tiny, well-known 32-bit string hash. Used to turn the key string into a seed. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * "lowbias32" integer finalizer by Chris Wellons. It is a bijection on uint32 with
 * excellent avalanche: flipping one input bit flips ~half the output bits. We use
 * it everywhere we need "one more independent random number" from a seed.
 */
export function mix32(x: number): number {
  x >>>= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Golden-ratio constant, the classic "odd multiplier" for decorrelating sequential ints. */
const GOLDEN = 0x9e3779b9;

/**
 * Seed for position t: combines the key with the previous `h` token ids.
 *
 * The fold is order-sensitive (each step scrambles before the next token is
 * XOR-ed in), so context [A, B] and [B, A] give different seeds. The paper's
 * simplest variant hashes only the previous token (h=1); SynthID hashes h=4.
 *
 * @param keyHash  output of `hashString(key)`
 * @param context  the h token ids immediately before the position being scored
 */
export function hashContext(keyHash: number, context: ArrayLike<number>): number {
  let h = keyHash >>> 0;
  for (let i = 0; i < context.length; i++) {
    h = mix32((h ^ (context[i] >>> 0)) >>> 0);
    h = (h + GOLDEN) >>> 0;
  }
  return mix32(h);
}

/**
 * Derive a pseudo-random uint32 for a (seed, token) pair. This is the function the
 * green list and the tournament g-values are read from. `salt` lets callers derive
 * *independent* streams from the same seed (SynthID uses one per tournament layer).
 */
export function hashToken(seed: number, tokenId: number, salt = 0): number {
  // Multiplying the token id by an odd constant spreads consecutive ids across the
  // whole 32-bit range before mixing, so nearby ids don't produce correlated hashes.
  const t = Math.imul(tokenId + 1, GOLDEN) >>> 0;
  return mix32((seed ^ t ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0);
}

/** Map a uint32 to a float in [0, 1). */
export function toUnit(h: number): number {
  return (h >>> 0) / 4294967296; // 2^32
}

/**
 * Small deterministic PRNG (mulberry32) used for the *sampling* randomness when the
 * user asks for a reproducible run. Note this is unrelated to the watermark key: the
 * key decides which tokens are favoured; this RNG decides which of them we draw.
 */
export function makeRng(seedText: string): () => number {
  let a = seedText ? hashString(seedText) : (Math.random() * 4294967296) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
