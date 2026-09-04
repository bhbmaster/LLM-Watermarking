/**
 * React hook that wraps the LLM Web Worker behind a promise-based API.
 *
 * The worker speaks in fire-and-forget messages (see `../worker/protocol.ts`). This
 * hook turns them back into something components can await:
 *
 *   const llm = useLLM();
 *   await llm.load(modelId, 'webgpu');                 // resolves on `ready`
 *   await llm.generate(args, { onToken });             // resolves on `done`
 *   const { ids, pieces } = await llm.tokenize(text);  // resolves on `tokenized`
 *
 * plus reactive `status` / `progress` / `error` state for rendering.
 * Requests carry an incrementing `requestId` so replies can be matched to callers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FromWorker, LoadProgress, LoadTarget, ToWorker } from '../worker/protocol';
import type { GenerationParams, PromptMode, WatermarkParams } from '../watermark/params';
import type { StepTrace } from '../watermark/processor';

/**
 * Lifecycle:  idle ──load──▶ loading ──ready──▶ ready ⇄ generating
 *                              └──error──▶ error ──load──▶ loading …
 * A failed generate/tokenize returns to `ready` (the model is still fine).
 */
export type LLMStatus = 'idle' | 'loading' | 'ready' | 'generating' | 'error';

/** One streamed token, delivered to `onToken` as soon as the worker samples it. */
export interface TokenEvent {
  tokenId: number;
  /** Decoded text of this token alone (may be a partial word or contain newlines). */
  piece: string;
  /** What the WatermarkLogitsProcessor saw at this step (probability, list colour, …). */
  trace: StepTrace;
}

export interface GenerateResult {
  tokenIds: number[];
  /** Full decoded text (the tokenizer joins pieces; this is what the detector sees). */
  text: string;
  elapsedMs: number;
  /** True if the user pressed Stop. */
  stopped: boolean;
}

export interface GenerateArgs {
  prompt: string;
  promptMode: PromptMode;
  generation: GenerationParams;
  watermark: WatermarkParams;
}

/** A caller waiting on the worker: resolve/reject the promise, plus a token stream sink. */
interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onToken?: (t: TokenEvent) => void;
}

export function useLLM() {
  // Refs rather than state for the plumbing: none of this should trigger re-renders.
  const workerRef = useRef<Worker | null>(null);
  /** requestId → waiting caller, for generate/tokenize (which can be interleaved). */
  const pending = useRef(new Map<number, Pending>());
  /** Loads have no requestId (only one model at a time), so their waiters form a list. */
  const loadWaiters = useRef<Pending[]>([]);
  const nextId = useRef(1);

  // Reactive state for the UI.
  const [status, setStatus] = useState<LLMStatus>('idle');
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [loaded, setLoaded] = useState<LoadTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Create the worker once. Vite understands `new Worker(new URL(...), { type: 'module' })`
  // and bundles the worker file separately (see vite.config.ts `worker.format`).
  // The effect's cleanup terminates it on unmount. That also frees GPU memory.
  useEffect(() => {
    const worker = new Worker(new URL('../worker/llm.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    // Demultiplex worker replies back to the waiting promise / stream handler.
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'progress':
          // Download / init progress while loading (percent may be null for "unknown").
          setProgress(msg.progress);
          break;

        case 'ready':
          // Model + tokenizer are in memory and warmed up. Wake every load() caller.
          setLoaded({ modelId: msg.modelId, device: msg.device, dtype: msg.dtype });
          setProgress(null);
          setStatus('ready');
          loadWaiters.current.splice(0).forEach((w) => w.resolve(undefined));
          break;

        case 'token': {
          // Streaming: forward to the caller's onToken; the promise stays pending.
          pending.current.get(msg.requestId)?.onToken?.({ tokenId: msg.tokenId, piece: msg.piece, trace: msg.trace });
          break;
        }

        case 'done': {
          // Generation finished (EOS, max tokens or Stop). Resolve with the full result.
          const p = pending.current.get(msg.requestId);
          pending.current.delete(msg.requestId);
          setStatus('ready');
          p?.resolve({ tokenIds: msg.tokenIds, text: msg.text, elapsedMs: msg.elapsedMs, stopped: msg.stopped });
          break;
        }

        case 'tokenized': {
          // Reply to tokenize(); does not touch status (it is a quick side query).
          const p = pending.current.get(msg.requestId);
          pending.current.delete(msg.requestId);
          p?.resolve({ ids: msg.ids, pieces: msg.pieces });
          break;
        }

        case 'error': {
          const err = new Error(msg.message);
          setError(msg.message);
          if (msg.requestId !== undefined) {
            const p = pending.current.get(msg.requestId);
            pending.current.delete(msg.requestId);
            p?.reject(err);
            // A failed generate/tokenize does not unload the model.
            setStatus((s) => (s === 'generating' ? 'ready' : s));
          } else {
            // Errors during load are fatal for that load attempt.
            loadWaiters.current.splice(0).forEach((w) => w.reject(err));
            setStatus('error');
          }
          break;
        }
      }
    };

    // Uncaught exception inside the worker (not a protocol 'error' message).
    worker.onerror = (ev) => {
      setError(ev.message || 'Worker crashed');
      setStatus('error');
    };

    return () => worker.terminate();
  }, []);

  const send = useCallback((msg: ToWorker) => workerRef.current?.postMessage(msg), []);

  // ── Public API. Each method posts a message and returns a promise settled by onmessage. ──

  /** Download (if needed), create the inference session and warm it up. */
  const load = useCallback(
    (target: LoadTarget) =>
      new Promise<void>((resolve, reject) => {
        setError(null);
        setStatus('loading');
        setProgress({ percent: null, text: 'Starting…' });
        loadWaiters.current.push({ resolve: () => resolve(), reject });
        send({ type: 'load', ...target });
      }),
    [send],
  );

  /** Run one generation. Tokens stream to `onToken`. The promise resolves with the whole text. */
  const generate = useCallback(
    (args: GenerateArgs, handlers: { onToken?: (t: TokenEvent) => void } = {}) =>
      new Promise<GenerateResult>((resolve, reject) => {
        const requestId = nextId.current++;
        pending.current.set(requestId, {
          resolve: (v) => resolve(v as GenerateResult),
          reject,
          onToken: handlers.onToken,
        });
        setError(null);
        setStatus('generating');
        send({ type: 'generate', requestId, ...args });
      }),
    [send],
  );

  /** Interrupt the current generation. The pending generate() still resolves (stopped=true). */
  const stop = useCallback(() => send({ type: 'stop' }), [send]);

  /** Tokenise arbitrary text with the loaded model's tokenizer (used by the detector). */
  const tokenize = useCallback(
    (text: string) =>
      new Promise<{ ids: number[]; pieces: string[] }>((resolve, reject) => {
        const requestId = nextId.current++;
        pending.current.set(requestId, { resolve: (v) => resolve(v as { ids: number[]; pieces: string[] }), reject });
        send({ type: 'tokenize', requestId, text });
      }),
    [send],
  );

  // Memoised so components receiving `llm` as a prop only re-render when something changed.
  return useMemo(
    () => ({ status, progress, loaded, error, load, generate, stop, tokenize }),
    [status, progress, loaded, error, load, generate, stop, tokenize],
  );
}

/** The hook's return type, for components that take the handle as a prop. */
export type LLM = ReturnType<typeof useLLM>;
