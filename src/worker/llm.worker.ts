/**
 * The LLM Web Worker: owns the tokenizer + model and does all the heavy work.
 *
 * A language model is large and slow. If it ran on the page thread, the buttons would
 * freeze during download and during every next-token step. A Web Worker is a second
 * JavaScript thread. The page sends messages. This file replies.
 *
 * Lifecycle
 *   1. UI posts `load`      → download (or read from browser cache) the ONNX weights,
 *                              create a WebGPU (or WASM) session, reply `ready`.
 *   2. UI posts `generate`  → build the prompt, run `model.generate()` with our
 *                              `WatermarkLogitsProcessor`, stream `token` messages,
 *                              finish with `done`.
 *   3. UI posts `stop`      → flip the InterruptableStoppingCriteria so the generate
 *                              loop exits after the current forward pass.
 *   4. UI posts `tokenize`  → the detector needs token ids for arbitrary text.
 *
 * Model code stays here. Watermark math (`../watermark/*`) is plain TypeScript that
 * the UI thread also uses for detection.
 */

import {
  AutoModelForCausalLM,
  AutoTokenizer,
  InterruptableStoppingCriteria,
  LogitsProcessorList,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type ProgressInfo,
  type Tensor,
} from '@huggingface/transformers';
import { WatermarkLogitsProcessor } from '../watermark/processor';
import type { FromWorker, LoadTarget, ToWorker } from './protocol';

// ─────────────────────────────────────────── state ───────────────────────────────────────────

// Module-level singletons: a worker hosts exactly one model at a time.
let tokenizer: PreTrainedTokenizer | null = null;
let model: PreTrainedModel | null = null;
/** What is currently in memory (id + device + dtype), or null. Compared on `load`. */
let loaded: LoadTarget | null = null;
/** Guards against overlapping load/generate calls; the UI also disables its buttons. */
let busy = false;

/** Lets the UI interrupt a running `generate()`; reset before every run. */
const stopper = new InterruptableStoppingCriteria();

const post = (msg: FromWorker) => self.postMessage(msg);

// ──────────────────────────────────────── message loop ───────────────────────────────────────

// Every request is handled here; any exception becomes a protocol-level `error` message
// (with the requestId when the request had one, so the right promise is rejected).
self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'load':
        await load({ modelId: msg.modelId, device: msg.device, dtype: msg.dtype });
        break;
      case 'generate':
        await generate(msg);
        break;
      case 'stop':
        stopper.interrupt();
        break;
      case 'tokenize':
        tokenize(msg.requestId, msg.text);
        break;
    }
  } catch (err) {
    const requestId = 'requestId' in msg ? msg.requestId : undefined;
    post({ type: 'error', message: err instanceof Error ? err.message : String(err), requestId });
    busy = false;
  }
};

// ─────────────────────────────────────────── loading ─────────────────────────────────────────

/**
 * Download (or read from Cache Storage), build the inference session and warm it up.
 * Idempotent: asking for the model that is already loaded just replies `ready`.
 */
async function load(target: LoadTarget): Promise<void> {
  const { modelId, device, dtype } = target;
  if (loaded && loaded.modelId === modelId && loaded.device === device && loaded.dtype === dtype && model && tokenizer) {
    post({ type: 'ready', ...loaded });
    return;
  }
  if (busy) throw new Error('Cannot switch models while generating.');
  busy = true;

  // Free the previous model's GPU buffers before allocating the new one.
  if (model) {
    await model.dispose();
    model = null;
    loaded = null;
  }

  // Transformers.js reports per-file progress; `progress_total` aggregates all files.
  const onProgress = (info: ProgressInfo) => {
    if (info.status === 'progress_total') {
      post({
        type: 'progress',
        progress: {
          percent: info.progress,
          text: `Downloading ${formatBytes(info.loaded)} / ${formatBytes(info.total)}`,
        },
      });
    } else if (info.status === 'initiate') {
      post({ type: 'progress', progress: { percent: null, text: `Fetching ${info.file}…` } });
    }
  };

  post({ type: 'progress', progress: { percent: null, text: 'Loading tokenizer…' } });
  tokenizer = await AutoTokenizer.from_pretrained(modelId, { progress_callback: onProgress });

  post({ type: 'progress', progress: { percent: 0, text: 'Loading model…' } });
  try {
    model = await AutoModelForCausalLM.from_pretrained(modelId, {
      // q4f16 = 4-bit weights with fp16 activations: the smallest download and the fastest
      // on WebGPU with fp16 shaders. q4 (fp32 activations) is the fallback chosen by the UI
      // for GPUs without fp16 and for the WASM/CPU path.
      dtype,
      device,
      progress_callback: onProgress,
    });

    post({ type: 'progress', progress: { percent: 100, text: 'Compiling shaders / warming up…' } });
    // First run of a WebGPU model compiles all shaders (can take a few seconds). Do a
    // 1-token dummy generation now so the user's first real request is fast.
    const warm = tokenizer('hi', { return_tensor: true });
    await model.generate({ ...warm, max_new_tokens: 1, do_sample: false });
  } catch (err) {
    // A failed load (out of GPU memory, network error…) must not leave a half-built model.
    await model?.dispose().catch(() => {});
    model = null;
    throw err;
  } finally {
    busy = false;
  }

  loaded = target;
  post({ type: 'ready', ...target });
}

// ────────────────────────────────────────── generation ───────────────────────────────────────

/**
 * One generation run. The interesting part is that *our* processor does the sampling
 * (so it can apply the watermark) and Transformers.js's loop is reduced to a driver that
 * runs the forward pass, hands us the logits, and appends whichever token we return.
 */
async function generate(req: Extract<ToWorker, { type: 'generate' }>): Promise<void> {
  if (!model || !tokenizer) throw new Error('Model not loaded yet.');
  if (busy) throw new Error('Already generating.');
  busy = true;
  stopper.reset();

  const { requestId, prompt, promptMode, generation, watermark } = req;
  const tok = tokenizer;

  // ── Prompt → input ids ──
  // Instruction mode wraps the prompt in the chat template ("<|im_start|>user … <|im_start|>assistant").
  // `enable_thinking: false` makes Qwen3 skip its <think>…</think> reasoning block so the
  // visible output is the answer itself. Continuation mode feeds the raw text.
  // (The type definitions don't list template-specific kwargs such as `enable_thinking`,
  // but `apply_chat_template` forwards any extra option to the Jinja template.)
  const templateOptions = {
    add_generation_prompt: true,
    return_dict: true as const,
    enable_thinking: false,
  } as Parameters<PreTrainedTokenizer['apply_chat_template']>[1];
  const inputs = (
    promptMode === 'instruction'
      ? tok.apply_chat_template([{ role: 'user', content: prompt }], templateOptions)
      : tok(prompt, { return_tensor: true })
  ) as { input_ids: Tensor; attention_mask: Tensor };

  // ── EOS ids: exempt from the red list so a hard watermark can still end the text ──
  const eosTokenIds = normalizeIds(model.generation_config?.eos_token_id ?? tok.config?.eos_token_id);
  const eosSet = new Set(eosTokenIds);

  // ── "Force onto the red list": map words → every token id they may tokenise to ──
  const vocabSize = Number((model.config as unknown as { vocab_size: number }).vocab_size);
  const forcedRed = buildForcedRedMask(tok, watermark.forceRedWords, vocabSize);

  const generated: number[] = [];
  const processor = new WatermarkLogitsProcessor({
    watermark,
    generation,
    eosTokenIds,
    forcedRed,
    onStep: (trace) => {
      // The processor already chose the token; stream it out right away.
      if (eosSet.has(trace.tokenId)) return; // don't display <|im_end|> etc.
      generated.push(trace.tokenId);
      post({
        type: 'token',
        requestId,
        tokenId: trace.tokenId,
        piece: tok.decode([trace.tokenId], { skip_special_tokens: false }),
        trace,
      });
    },
  });
  const processors = new LogitsProcessorList();
  processors.push(processor);

  const t0 = performance.now();
  try {
    await model.generate({
      ...inputs,
      max_new_tokens: generation.maxNewTokens,
      // Greedy on purpose: our processor collapses the logits onto the token *it* sampled,
      // so argmax == our choice. See WatermarkLogitsProcessor for why.
      do_sample: false,
      // Built-in processors run *before* ours, so repetition penalty is applied to the raw
      // logits and the watermark sees the penalised version — same order as HF Python.
      repetition_penalty: generation.repetitionPenalty,
      logits_processor: processors,
      stopping_criteria: stopper,
    });
  } finally {
    busy = false;
  }

  post({
    type: 'done',
    requestId,
    tokenIds: generated,
    // Decoding the full sequence at once merges byte-level BPE pieces into proper UTF-8.
    text: tok.decode(generated, { skip_special_tokens: true }),
    elapsedMs: performance.now() - t0,
    stopped: stopper.interrupted,
  });
}

// ─────────────────────────────────────────── tokenize ────────────────────────────────────────

/** Tokenise text for the detector and return both ids and per-token display pieces. */
function tokenize(requestId: number, text: string): void {
  if (!tokenizer) throw new Error('Model not loaded yet.');
  // No special tokens: the detector should see exactly what a third party would get by
  // tokenising the text they were handed.
  const ids = tokenizer.encode(text, { add_special_tokens: false });
  const pieces = ids.map((id) => tokenizer!.decode([id], { skip_special_tokens: false }));
  post({ type: 'tokenized', requestId, ids, pieces });
}

// ─────────────────────────────────────────── helpers ─────────────────────────────────────────

/** `eos_token_id` may be a number, a bigint or an array (Qwen3 has two EOS ids). */
function normalizeIds(x: unknown): number[] {
  if (Array.isArray(x)) return x.map(Number);
  if (typeof x === 'number' || typeof x === 'bigint') return [Number(x)];
  return [];
}

/**
 * A word can tokenise differently depending on capitalisation and whether it follows a
 * space (BPE vocabularies have separate " Paris" and "Paris" tokens). We red-list the
 * tokens of every common surface form so the word is effectively suppressed. Multi-token
 * words have *all* their pieces red-listed, which also suppresses other words sharing a
 * piece — a limitation worth noticing when you experiment.
 */
function buildForcedRedMask(tok: PreTrainedTokenizer, words: string[], vocabSize: number): Uint8Array | null {
  if (words.length === 0) return null;
  const mask = new Uint8Array(vocabSize);
  for (const raw of words) {
    const w = raw.trim();
    if (!w) continue;
    const forms = new Set([w, w.toLowerCase(), w.toUpperCase(), w[0].toUpperCase() + w.slice(1).toLowerCase()]);
    for (const f of forms) {
      for (const text of [f, ' ' + f]) {
        for (const id of tok.encode(text, { add_special_tokens: false })) {
          if (id < vocabSize) mask[id] = 1;
        }
      }
    }
  }
  return mask;
}

/** "1.43 GB" / "512 MB" / "38 kB" for the progress line. */
function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e3).toFixed(0)} kB`;
}
