/**
 * Catalog of models this app can download and run.
 *
 * A "model" here is a trained language model: a large table of numbers (weights) plus
 * a tokenizer that splits text into token ids. This app does not train models. It
 * downloads a ready-made copy from the Hugging Face Hub and runs it in the browser.
 *
 * Every row is a decoder-only text model with ONNX weights that Transformers.js v4
 * can load. Sizes come from the Hub API (sum of `onnx/model_<dtype>.onnx*` files).
 * That size is what lands in the browser cache and what `hardware.ts` uses for fit.
 *
 * Two quantisations (compressed copies of the same model):
 *  - `q4f16`  4-bit weights, fp16 math — smallest and fastest on WebGPU with fp16
 *  - `q4`     4-bit weights, fp32 math — larger; use when the GPU has no fp16
 *
 * Instruction-tuned models have a chat template, so "Instruction" mode wraps your
 * prompt as a user message. Qwen3 also accepts `enable_thinking: false`; others ignore it.
 *
 * `mmlu` is a published quiz score (higher is stronger). `released` is the weight date.
 */

export type Dtype = 'q4f16' | 'q4';

export interface ModelSpec {
  /** Hugging Face repo id, e.g. "onnx-community/Qwen3-0.6B-ONNX". */
  id: string;
  /** Short display name. */
  name: string;
  /** Parameter count for display, e.g. "0.6B". */
  params: string;
  /** Download size in GB for each available dtype (undefined = not published). */
  sizeGB: Partial<Record<Dtype, number>>;
  /** One-line description shown in the picker. */
  blurb: string;
  /** Release date of the model weights (YYYY-MM-DD), so you can tell how recent it is. */
  released: string;
  /**
   * MMLU score (5-shot, %) as a single "how good is it" number, taken from the model's
   * card / technical report. 25 is random guessing, ~70 is GPT-3.5 class, ~85+ frontier.
   * Where the publisher reports only the base model or a close variant, the figure is
   * marked approximate. Small models are all weak on MMLU; the score is for comparing
   * *between* rows, not a promise about answer quality on your prompt.
   */
  mmlu: { score: number; approx?: boolean };
}

/** 1–5 star rating derived from MMLU so quality can be read at a glance. */
export function qualityStars(mmlu: number): number {
  if (mmlu >= 80) return 5;
  if (mmlu >= 65) return 4;
  if (mmlu >= 55) return 3;
  if (mmlu >= 45) return 2;
  return 1;
}

/** "2025-04-29" → "Apr 2025". */
export function formatReleased(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export const CATALOG: ModelSpec[] = [
  // ── tiny: runs almost anywhere, including CPU/WASM ──
  {
    id: 'HuggingFaceTB/SmolLM2-135M-Instruct',
    name: 'SmolLM2 135M',
    params: '135M',
    sizeGB: { q4f16: 0.12, q4: 0.18 },
    blurb: 'Smallest option. Fine for watching the algorithms work; text quality is basic.',
    released: '2024-10-31',
    mmlu: { score: 30, approx: true },
  },
  {
    id: 'onnx-community/LFM2-350M-ONNX',
    name: 'LFM2 350M',
    params: '350M',
    sizeGB: { q4f16: 0.26, q4: 0.29 },
    blurb: 'Liquid AI hybrid model; fast and surprisingly coherent for its size.',
    released: '2025-07-10',
    mmlu: { score: 43.4 },
  },
  {
    id: 'HuggingFaceTB/SmolLM2-360M-Instruct',
    name: 'SmolLM2 360M',
    params: '360M',
    sizeGB: { q4f16: 0.27, q4: 0.39 },
    blurb: 'Small English chat model from Hugging Face.',
    released: '2024-10-31',
    mmlu: { score: 35, approx: true },
  },
  {
    id: 'onnx-community/gemma-3-270m-it-ONNX',
    name: 'Gemma 3 270M',
    params: '270M',
    sizeGB: { q4f16: 0.27, q4: 0.32 },
    blurb: 'Google Gemma 3, instruction tuned. Large vocabulary (262k tokens).',
    released: '2025-08-14',
    mmlu: { score: 30, approx: true },
  },
  {
    id: 'onnx-community/Qwen2.5-0.5B-Instruct',
    name: 'Qwen2.5 0.5B',
    params: '0.5B',
    sizeGB: { q4f16: 0.48, q4: 0.79 },
    blurb: 'Compact multilingual chat model.',
    released: '2024-09-19',
    mmlu: { score: 47.5 },
  },

  // ── small: comfortable on any laptop with WebGPU ──
  {
    id: 'onnx-community/Qwen3-0.6B-ONNX',
    name: 'Qwen3 0.6B',
    params: '0.6B',
    sizeGB: { q4f16: 0.57, q4: 0.92 },
    blurb: 'Good default: quick to download, decent quality, thinking mode disabled via template.',
    released: '2025-04-29',
    mmlu: { score: 52.8 },
  },
  {
    id: 'onnx-community/gemma-3-1b-it-ONNX',
    name: 'Gemma 3 1B',
    params: '1B',
    sizeGB: { q4f16: 0.76, q4: 0.86 },
    blurb: 'Google Gemma 3 1B instruction tuned.',
    released: '2025-03-12',
    mmlu: { score: 38.8, approx: true },
  },
  {
    id: 'onnx-community/LFM2-1.2B-ONNX',
    name: 'LFM2 1.2B',
    params: '1.2B',
    sizeGB: { q4f16: 0.76, q4: 0.85 },
    blurb: 'Liquid AI hybrid model; efficient on modest GPUs.',
    released: '2025-07-10',
    mmlu: { score: 55.2 },
  },
  {
    id: 'onnx-community/Llama-3.2-1B-Instruct-ONNX',
    name: 'Llama 3.2 1B',
    params: '1B',
    sizeGB: { q4f16: 1.09, q4: 1.69 },
    blurb: 'Meta Llama 3.2, instruction tuned.',
    released: '2024-09-25',
    mmlu: { score: 49.3 },
  },
  {
    id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
    name: 'SmolLM2 1.7B',
    params: '1.7B',
    sizeGB: { q4f16: 1.11, q4: 1.41 },
    blurb: 'The largest SmolLM2; solid English chat.',
    released: '2024-10-31',
    mmlu: { score: 50, approx: true },
  },
  {
    id: 'onnx-community/Qwen2.5-1.5B-Instruct',
    name: 'Qwen2.5 1.5B',
    params: '1.5B',
    sizeGB: { q4f16: 1.22, q4: 1.79 },
    blurb: 'Well-rounded multilingual chat model.',
    released: '2024-09-19',
    mmlu: { score: 60.9 },
  },
  {
    id: 'onnx-community/Qwen3-1.7B-ONNX',
    name: 'Qwen3 1.7B',
    params: '1.7B',
    sizeGB: { q4f16: 1.43, q4: 2.15 },
    blurb: 'Noticeably better than 0.6B; still fast on integrated GPUs.',
    released: '2025-04-29',
    mmlu: { score: 62.6 },
  },

  // ── medium: 8 GB+ machines with a decent GPU ──
  {
    id: 'HuggingFaceTB/SmolLM3-3B-ONNX',
    name: 'SmolLM3 3B',
    params: '3B',
    sizeGB: { q4f16: 2.12, q4: 2.84 },
    blurb: 'Hugging Face 3B model with long context and multilingual support.',
    released: '2025-07-08',
    mmlu: { score: 59.5, approx: true },
  },
  {
    id: 'onnx-community/Phi-3.5-mini-instruct-onnx-web',
    name: 'Phi-3.5 mini',
    params: '3.8B',
    sizeGB: { q4f16: 2.32 },
    blurb: 'Microsoft Phi-3.5, exported specifically for the web.',
    released: '2024-08-20',
    mmlu: { score: 69.0 },
  },
  {
    id: 'onnx-community/Llama-3.2-3B-Instruct-ONNX',
    name: 'Llama 3.2 3B',
    params: '3B',
    sizeGB: { q4f16: 2.41, q4: 3.41 },
    blurb: 'Meta Llama 3.2 3B, instruction tuned.',
    released: '2024-09-25',
    mmlu: { score: 63.4 },
  },
  {
    id: 'onnx-community/Phi-4-mini-instruct-ONNX',
    name: 'Phi-4 mini',
    params: '3.8B',
    sizeGB: { q4f16: 2.55, q4: 2.82 },
    blurb: 'Microsoft Phi-4 mini; strong reasoning for its size.',
    released: '2025-02-26',
    mmlu: { score: 67.3 },
  },
  {
    id: 'onnx-community/Qwen3-4B-ONNX',
    name: 'Qwen3 4B',
    params: '4B',
    sizeGB: { q4f16: 2.83 },
    blurb: 'Best quality of the Qwen3 family that fits typical laptops.',
    released: '2025-04-29',
    mmlu: { score: 73.0 },
  },

  // ── large: 16 GB+ unified memory or a big discrete GPU ──
  {
    id: 'onnx-community/Apertus-8B-Instruct-2509-ONNX',
    name: 'Apertus 8B',
    params: '8B',
    sizeGB: { q4f16: 4.67, q4: 5.19 },
    blurb: 'Swiss open model (ETH/EPFL). Needs a machine with plenty of GPU memory.',
    released: '2025-09-02',
    mmlu: { score: 61, approx: true },
  },
  {
    id: 'onnx-community/gpt-oss-20b-ONNX',
    name: 'GPT-OSS 20B',
    params: '20B (MoE)',
    sizeGB: { q4f16: 12.62 },
    blurb: 'OpenAI open-weight MoE. Workstation / server class: ~16 GB+ of GPU memory.',
    released: '2025-08-05',
    mmlu: { score: 85.3 },
  },
];

export const DEFAULT_MODEL_ID = 'onnx-community/Qwen3-0.6B-ONNX';

export function findModel(id: string): ModelSpec | undefined {
  return CATALOG.find((m) => m.id === id);
}

/**
 * Rough peak memory needed to *run* a model, in GB, for a given dtype.
 *
 * Weights are loaded into GPU buffers (≈ download size), plus:
 *  - runtime overhead: shader pipelines, workspace buffers, the logits vector
 *    (vocab × fp32 per step — 0.6 MB for Qwen's 152k vocab, negligible),
 *  - KV cache: small for the short generations this playground does,
 *  - a copy of the weights may transiently exist in CPU memory while the session is created.
 * 1.3× + 0.4 GB is a deliberately conservative envelope; treat it as "you want at least
 * this much free", not as an exact figure.
 */
export function estimateMemoryGB(spec: ModelSpec, dtype: Dtype): number {
  const size = spec.sizeGB[dtype] ?? spec.sizeGB.q4f16 ?? spec.sizeGB.q4 ?? 0;
  return Math.round((size * 1.3 + 0.4) * 10) / 10;
}
