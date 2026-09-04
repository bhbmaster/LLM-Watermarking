/**
 * Left column: model picker, prompt, watermark mode, and all tunable parameters.
 *
 * This component is controlled. Every value lives in `App`.
 * The detector (right column) can then read the same γ / h / mode settings.
 *
 * Layout, top to bottom:
 *   1. Model      - which weights to run (opens the picker), plus load status
 *   2. Prompt     - the text, and whether it is a chat instruction or a continuation
 *   3. Mode       - None / Hard / Soft / Tournament
 *   4. Generation - sampling knobs shared by all modes (collapsed by default)
 *   5. Watermark  - scheme parameters. Which fields show depends on the mode:
 *                     Hard        γ, h, key, forced-red words
 *                     Soft        γ, δ, h, key, forced-red words
 *                     Tournament  h, depth m, key
 *                     None        γ, h, key (still used by the detector as a control)
 *   6. Action     - Generate / Stop
 *
 * Hover-help text lives in the HELP table below.
 */

import type { LLM } from '../hooks/useLLM';
import type { GenerationParams, PromptMode, WatermarkMode, WatermarkParams } from '../watermark/params';
import type { Device } from '../worker/protocol';
import { findModel, formatReleased, qualityStars } from '../models/catalog';
import { assessFit, type HardwareProfile } from '../models/hardware';
import { CACHE_NAME, describeStorageLocation, type CachedModel } from '../models/cache';
import { Badge, Collapsible, Field, Help, NumberField, Segmented, Stars } from './controls';

export interface ModelPanelProps {
  /** Worker handle: status, progress, error and the loaded model. */
  llm: LLM;
  /** Currently selected model (may differ from the *loaded* one until Generate is pressed). */
  modelId: string;
  /** Detected machine profile; null until detection finishes (a few ms after mount). */
  hardware: HardwareProfile | null;
  /** Models already present in the browser cache, for the "downloaded" badge. */
  cached: CachedModel[];
  onOpenPicker: () => void;
  device: Device;
  webgpuAvailable: boolean;

  prompt: string;
  onPromptChange: (p: string) => void;
  promptMode: PromptMode;
  onPromptModeChange: (m: PromptMode) => void;

  watermark: WatermarkParams;
  onWatermarkChange: (w: WatermarkParams) => void;
  forceRedText: string;
  onForceRedTextChange: (t: string) => void;

  generation: GenerationParams;
  onGenerationChange: (g: GenerationParams) => void;

  onGenerate: () => void;
  onStop: () => void;
}

/** Hover-help copy for every control. Keep the wording together so the tips stay consistent. */
const HELP = {
  promptMode:
    'Instruction: wrap your text in the chat template. The model answers as an assistant. ' +
    'Continuation: feed the raw text. The model keeps writing from that point.',
  mode:
    'None: plain sampling (control). Hard: red-list tokens are forbidden. Soft: green-list logits get +δ. ' +
    'Tournament: sample candidates. Hash-keyed g-functions pick the winner (SynthID-style).',
  gamma:
    'γ: fraction of the vocabulary that is green at each step. The rest is red. ' +
    'A smaller γ allows fewer tokens. The per-token signal is stronger. Distortion is higher.',
  delta:
    'δ: logit bonus added to green tokens in Soft mode. At confident positions δ changes nothing. ' +
    'At uncertain positions it tips the choice toward green. Typical values are 2 to 4.',
  h:
    'h: how many previous tokens are hashed with the key to pick this step\'s green list or g-functions. ' +
    'A larger h looks more random. One edit then corrupts the next h scores.',
  key: 'Secret key. The green lists and g-functions come from it. Detect with the same key to see the watermark. A different key gives z near 0.',
  depth:
    'Tournament depth m: number of knock-out layers (2^m virtual candidates). More layers give a stronger watermark. SynthID uses 30.',
  forceRed:
    'Playground aid: put every token of these words on the red list at every step. ' +
    'In Hard mode the model cannot emit them. In Soft mode they are discouraged. Force an obvious answer word and watch the model avoid it.',
  temperature: 'Divides logits before softmax. Values below 1 sharpen the distribution. Values above 1 flatten it. A sharper distribution weakens the watermark.',
  topK: 'Keep only the k most likely tokens before sampling. 0 = off.',
  topP: 'Nucleus sampling: keep the smallest set of tokens whose probabilities sum to at least p. 1 = off.',
  repetition: 'Penalise tokens already in the text (HF-style). 1 = off. Applied before the watermark.',
  seed: 'Seed for the sampling RNG. This is not the watermark key. Fill it in to make a run reproducible. Leave it blank for a random run.',
  maxTokens: 'Maximum number of tokens to generate. Longer texts give the detector more evidence. The z-score grows like √T.',
};

/**
 * The four schemes, in order of increasing subtlety:
 *   None       - control; plain sampling, nothing embedded.
 *   Hard       - Kirchenbauer "hard red list": red tokens get -Infinity logits, never sampled.
 *   Soft       - Kirchenbauer "soft": green tokens get +δ; confident positions are left alone.
 *   Tournament - SynthID-Text: keyed g-functions run a knock-out among sampled candidates.
 */
const MODE_OPTIONS: { value: WatermarkMode; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'hard', label: 'Hard' },
  { value: 'soft', label: 'Soft' },
  { value: 'tournament', label: 'Tournament' },
];

export function ModelPanel(p: ModelPanelProps) {
  const { llm, watermark: wm, generation: gen } = p;
  // While loading or generating, freeze model, mode, and prompt mode.
  // That keeps the run consistent with the display. Sliders stay editable.
  // They only affect the next run.
  const busy = llm.status === 'loading' || llm.status === 'generating';
  // Immutable-update helpers: replace one field of the params object.
  const set = <K extends keyof WatermarkParams>(k: K, v: WatermarkParams[K]) => p.onWatermarkChange({ ...wm, [k]: v });
  const setGen = <K extends keyof GenerationParams>(k: K, v: GenerationParams[K]) => p.onGenerationChange({ ...gen, [k]: v });

  return (
    <aside className="panel panel-left">
      {/* ── Model ── */}
      <Field label="Model" help="Pick from a catalog filtered by what this machine can run. Each model has a quality score (MMLU) and a release date. Weights download once into the browser's Cache Storage. See 'Downloads go to' in the picker. They are reused across sessions.">        
        <ModelButton modelId={p.modelId} hardware={p.hardware} cached={p.cached} disabled={busy} onClick={p.onOpenPicker} />
      </Field>
      <StatusLine llm={llm} device={p.device} webgpuAvailable={p.webgpuAvailable} modelId={p.modelId} />

      {/* ── Prompt ── */}
      <Field label="Prompt">
        <textarea
          rows={4}
          value={p.prompt}
          onChange={(e) => p.onPromptChange(e.currentTarget.value)}
          placeholder="Ask something, or paste text to continue…"
        />
      </Field>
      <div className="row">
        <Segmented
          options={[
            { value: 'instruction', label: 'Instruction' },
            { value: 'continuation', label: 'Continuation' },
          ]}
          value={p.promptMode}
          onChange={p.onPromptModeChange}
          disabled={busy}
        />
        <Help text={HELP.promptMode} />
      </div>

      {/* ── Watermark mode ── */}
      <Field label="Watermarking mode" help={HELP.mode}>
        <Segmented options={MODE_OPTIONS} value={wm.mode} onChange={(m) => set('mode', m)} disabled={busy} />
      </Field>

      {/* ── Generation parameters ── */}
      <Collapsible title="Generation parameters">
        <div className="grid3">
          <NumberField label="max tokens" help={HELP.maxTokens} value={gen.maxNewTokens} min={1} max={2048} step={1} onChange={(v) => setGen('maxNewTokens', v)} />
          <NumberField label="temperature" help={HELP.temperature} value={gen.temperature} min={0.01} max={5} step={0.1} onChange={(v) => setGen('temperature', v)} />
          <NumberField label="repetition" help={HELP.repetition} value={gen.repetitionPenalty} min={1} max={2} step={0.05} onChange={(v) => setGen('repetitionPenalty', v)} />
          <NumberField label="top-k" help={HELP.topK} value={gen.topK} min={0} max={1000} step={1} onChange={(v) => setGen('topK', v)} />
          <NumberField label="top-p" help={HELP.topP} value={gen.topP} min={0.01} max={1} step={0.05} onChange={(v) => setGen('topP', v)} />
          <Field label="seed" help={HELP.seed}>
            <input type="text" value={gen.seed} placeholder="random" onChange={(e) => setGen('seed', e.currentTarget.value)} />
          </Field>
        </div>
      </Collapsible>

      {/* ── Watermarking parameters (which ones show depends on the mode) ── */}
      <Collapsible title="Watermarking parameters" defaultOpen>
        {wm.mode === 'none' && <p className="muted small">No watermark is applied. Detection still runs with the γ / h below, as a control.</p>}
        <div className="grid3">
          {/* γ only matters for the list schemes (and the list-scheme detector used in None). */}
          {wm.mode !== 'tournament' && (
            <NumberField label="γ fraction" help={HELP.gamma} value={wm.gamma} min={0.05} max={0.95} step={0.05} onChange={(v) => set('gamma', v)} />
          )}
          {/* δ is the soft bias; Hard is the δ → ∞ limit so it has no slider. */}
          {wm.mode === 'soft' && (
            <NumberField label="δ bias" help={HELP.delta} value={wm.delta} min={0} max={20} step={0.5} onChange={(v) => set('delta', v)} />
          )}
          {/* h is shared by every scheme: it is the size of the hashed context window. */}
          <NumberField label="h context" help={HELP.h} value={wm.h} min={1} max={16} step={1} onChange={(v) => set('h', v)} />
          {/* m = tournament layers; the statistic averages over T·m g-values. */}
          {wm.mode === 'tournament' && (
            <NumberField label="depth m" help={HELP.depth} value={wm.depth} min={1} max={64} step={1} onChange={(v) => set('depth', v)} />
          )}
        </div>
        <Field label="key" help={HELP.key}>
          <input type="text" className="key-input" value={wm.key} onChange={(e) => set('key', e.currentTarget.value)} spellCheck={false} />
        </Field>
        {wm.mode !== 'tournament' && (
          <Field
            label={
              <>
                Force onto the red list <span className="muted">(optional, comma-separated)</span>
              </>
            }
            help={HELP.forceRed}
          >
            <input
              type="text"
              value={p.forceRedText}
              onChange={(e) => p.onForceRedTextChange(e.currentTarget.value)}
              placeholder="Example: Paris, lighthouse, fire"
              disabled={wm.mode === 'none'}
            />
          </Field>
        )}
      </Collapsible>

      {/* Action button. The label shows the cost of the next click:
          "Download model & generate" on first use.
          "Load model & generate" when cached but not in memory.
          "Generate" when ready. While generating, the button becomes Stop. */}
      {llm.status === 'generating' ? (
        <button type="button" className="btn btn-stop" onClick={p.onStop}>
          Stop
        </button>
      ) : (
        <button type="button" className="btn btn-primary" onClick={p.onGenerate} disabled={busy || !p.prompt.trim()}>
          {llm.status === 'loading'
            ? 'Loading model…'
            : llm.loaded?.modelId === p.modelId
              ? 'Generate'
              : p.cached.some((c) => c.id === p.modelId)
                ? 'Load model & generate'
                : 'Download model & generate'}
        </button>
      )}
    </aside>
  );
}

/** The current model as a button (name · size · score · date · cached) that opens the picker. */
function ModelButton(props: { modelId: string; hardware: HardwareProfile | null; cached: CachedModel[]; disabled: boolean; onClick: () => void }) {
  const spec = findModel(props.modelId);
  const fit = spec && props.hardware ? assessFit(spec, props.hardware) : null;
  const isCached = props.cached.some((c) => c.id === props.modelId);
  return (
    <button type="button" className="model-button" onClick={props.onClick} disabled={props.disabled}>
      <span className="model-button-main">
        <strong>{spec?.name ?? props.modelId}</strong>
        {spec && <span className="muted"> {spec.params}</span>}
        {fit && <span className="muted"> · {fit.downloadGB.toFixed(2)} GB</span>}
        {spec && (
          <span className="model-button-meta muted">
            {' '}
            · <Stars n={qualityStars(spec.mmlu.score)} title={`MMLU ${spec.mmlu.approx ? '≈' : ''}${spec.mmlu.score}`} /> MMLU {spec.mmlu.approx ? '≈' : ''}
            {spec.mmlu.score} · {formatReleased(spec.released)}
          </span>
        )}
      </span>
      <span className="row">
        {fit && fit.level !== 'fits' && <Badge tone={fit.level === 'too-big' ? 'red' : 'amber'}>{fit.level === 'too-big' ? 'too big' : fit.level}</Badge>}
        {isCached && <Badge tone="green">downloaded</Badge>}
        <span className="muted">▾</span>
      </span>
    </button>
  );
}

/**
 * One-line status under the model button, plus the compute-backend badge.
 * While loading, a progress bar uses Transformers.js download callbacks.
 * Message priority: error, loading, generating, ready for this model,
 * ready for another model, nothing loaded.
 */
function StatusLine({ llm, device, webgpuAvailable, modelId }: { llm: LLM; device: Device; webgpuAvailable: boolean; modelId: string }) {
  const loc = describeStorageLocation();
  let text: string;
  if (llm.status === 'error') text = llm.error ?? 'Error';
  else if (llm.status === 'loading') text = llm.progress?.text ?? 'Loading…';
  else if (llm.status === 'generating') text = 'Generating…';
  else if (llm.loaded && llm.loaded.modelId === modelId) text = 'Done. Try the detector.';
  else if (llm.loaded) text = 'Different model loaded. Press Generate to switch.';
  else text = 'Model not loaded. Weights download once and are cached by your browser.';

  return (
    <div className="status">
      <div className="status-row">
        <span className={llm.status === 'error' ? 'error-text' : 'muted'}>{text}</span>
        <Badge tone={device === 'webgpu' ? 'green' : 'amber'}>{device === 'webgpu' ? 'WebGPU' : 'WASM (slow)'}</Badge>
      </div>
      <div className="muted small model-where" title={loc.path ?? undefined}>
        Stored in {loc.browser}'s Cache Storage → <code>{CACHE_NAME}</code>
        {loc.path ? ` · ${loc.path}` : ''}
      </div>
      {!webgpuAvailable && <div className="warn small">WebGPU is not available in this browser; falling back to CPU (WASM). Expect very slow generation.</div>}
      {llm.status === 'loading' && (
        <div className="progress">
          <div className="progress-bar" style={{ width: `${llm.progress?.percent ?? 0}%` }} />
        </div>
      )}
    </div>
  );
}
