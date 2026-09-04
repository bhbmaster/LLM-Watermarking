/**
 * Message protocol between the UI thread and the LLM Web Worker.
 *
 * Running a multi-GB model must happen off the main thread or the page would freeze
 * during downloads and every forward pass. The UI and worker only ever exchange the
 * plain-data messages below via `postMessage`. Discriminated unions on `type` let
 * TypeScript check both ends of the conversation.
 */

import type { GenerationParams, PromptMode, WatermarkParams } from '../watermark/params';
import type { StepTrace } from '../watermark/processor';
import type { Dtype } from '../models/catalog';

/** Compute backend. WebGPU is ~10-50× faster; WASM is the fallback for old browsers. */
export type Device = 'webgpu' | 'wasm';

/** Everything that identifies one loaded model session. */
export interface LoadTarget {
  modelId: string;
  device: Device;
  /** Chosen on the UI thread from the hardware profile (see models/hardware.ts). */
  dtype: Dtype;
}

// ───────────────────────────── UI → worker ─────────────────────────────

export type ToWorker =
  /** Download if needed and build the session. No requestId: at most one load at a time. */
  | ({ type: 'load' } & LoadTarget)
  /** Run one generation. `requestId` ties the streamed `token`s and the final `done` to the caller. */
  | {
      type: 'generate';
      requestId: number;
      prompt: string;
      promptMode: PromptMode;
      generation: GenerationParams;
      watermark: WatermarkParams;
    }
  /** Interrupt the running generation after the current forward pass. */
  | { type: 'stop' }
  /** Tokenise arbitrary text (the detector works on tokens, not characters). */
  | { type: 'tokenize'; requestId: number; text: string };

// ───────────────────────────── worker → UI ─────────────────────────────

export interface LoadProgress {
  /** Overall 0–100 across all files, when known. */
  percent: number | null;
  /** Human readable status line, e.g. "Downloading model_q4f16.onnx_data (1.2 / 2.1 GB)". */
  text: string;
}

export type FromWorker =
  /** Download / initialisation progress while loading. */
  | { type: 'progress'; progress: LoadProgress }
  /** Model is in memory and warmed up; echoes what was loaded. */
  | ({ type: 'ready' } & LoadTarget)
  /** Something threw. With `requestId` it fails that request; without, it fails the load. */
  | { type: 'error'; message: string; requestId?: number }
  /** One generated token. `piece` is the token decoded on its own (may be a partial character). */
  | { type: 'token'; requestId: number; tokenId: number; piece: string; trace: StepTrace }
  /** Generation finished (EOS, max tokens or stop). */
  | {
      type: 'done';
      requestId: number;
      tokenIds: number[];
      /** Full decoded output text (decoding the whole sequence fixes multi-byte characters). */
      text: string;
      elapsedMs: number;
      stopped: boolean;
    }
  /** Reply to `tokenize`: ids plus each id decoded alone, for the chip view. */
  | { type: 'tokenized'; requestId: number; ids: number[]; pieces: string[] };
