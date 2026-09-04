/**
 * Top-level page: owns all state and runs the two workflows.
 *
 *   Generate:  prompt + settings → worker (model + watermark) → token stream
 *   Detect:    output text → tokenize → detect() on this thread → colour the tokens
 *
 * State lives here, not in the three panels. The detector must use the same
 * γ / h / mode / depth as the generator. The output panel needs both the write
 * traces and the detect scores.
 *
 * If you do not know the terms yet, start at `src/main.tsx`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLLM } from './hooks/useLLM';
import { detect, schemeFor, type DetectionResult } from './watermark/detect';
import {
  DEFAULT_GENERATION,
  DEFAULT_WATERMARK,
  parseWordList,
  type GenerationParams,
  type PromptMode,
  type WatermarkParams,
} from './watermark/params';
import type { Device, LoadTarget } from './worker/protocol';
import { DEFAULT_MODEL_ID, findModel } from './models/catalog';
import { detectHardware, pickDtype, recommendModel, type HardwareProfile } from './models/hardware';
import { deleteCachedModel, listCachedModels, type CachedModel } from './models/cache';
import { DetectionPanel } from './ui/DetectionPanel';
import { ModelPanel } from './ui/ModelPanel';
import { ModelPicker } from './ui/ModelPicker';
import { OutputPanel, type DisplayToken, type OutputStats } from './ui/OutputPanel';

/** Remember settings across reloads so experiments are easy to resume. */
function usePersistent<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`wm:${key}`);
      if (raw === null) return initial;
      const parsed = JSON.parse(raw) as T;
      // For settings objects, merge over the defaults so newly added fields get a value
      // even if an older version of the app stored the object. Use primitives as they are.
      const isPlainObject = (v: unknown): v is object => typeof v === 'object' && v !== null && !Array.isArray(v);
      return isPlainObject(initial) && isPlainObject(parsed) ? { ...initial, ...parsed } : parsed;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    localStorage.setItem(`wm:${key}`, JSON.stringify(value));
  }, [key, value]);
  return [value, setValue] as const;
}

export default function App() {
  const llm = useLLM();

  // ── Hardware & downloaded models ──
  // Detected once at startup. Drives which models are offered, which quantisation is
  // loaded, and the default model for a first-time visitor.
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [cached, setCached] = useState<CachedModel[]>([]);
  const refreshCache = useCallback(() => listCachedModels().then(setCached).catch(() => {}), []);
  useEffect(() => {
    detectHardware().then(setHardware);
    void refreshCache();
  }, [refreshCache]);

  // WebGPU is required for usable speed. WASM is only a fallback so the app still runs.
  const webgpuAvailable = hardware ? hardware.webgpu : typeof navigator !== 'undefined' && 'gpu' in navigator;
  const device: Device = webgpuAvailable ? 'webgpu' : 'wasm';

  // ── Settings ──
  // Empty string means "never chosen". Use the hardware-based recommendation once we have a profile.
  const [storedModelId, setModelId] = usePersistent('modelId', '');
  const modelId = useMemo(() => {
    if (storedModelId && findModel(storedModelId)) return storedModelId;
    return hardware ? recommendModel(hardware).id : DEFAULT_MODEL_ID;
  }, [storedModelId, hardware]);
  const [pickerOpen, setPickerOpen] = useState(false);

  /** What to load for a given model on this machine (dtype depends on fp16 support). */
  const loadTargetFor = useCallback(
    (id: string): LoadTarget => {
      const spec = findModel(id);
      const dtype = spec && hardware ? pickDtype(spec, hardware) : device === 'webgpu' ? 'q4f16' : 'q4';
      return { modelId: id, device, dtype };
    },
    [hardware, device],
  );
  const [prompt, setPrompt] = usePersistent('prompt', 'Summarise the Lord of the Rings books.');
  const [promptMode, setPromptMode] = usePersistent<PromptMode>('promptMode', 'instruction');
  const [watermark, setWatermark] = usePersistent<WatermarkParams>('watermark', DEFAULT_WATERMARK);
  const [generation, setGeneration] = usePersistent<GenerationParams>('generation', DEFAULT_GENERATION);
  const [forceRedText, setForceRedText] = usePersistent('forceRed', '');
  const [detectorKey, setDetectorKey] = usePersistent('detectorKey', DEFAULT_WATERMARK.key);
  const [ignoreRepeats, setIgnoreRepeats] = usePersistent('ignoreRepeats', true);
  const [retokenize, setRetokenize] = usePersistent('retokenize', true);

  // ── Output ──
  /** Tokens exactly as generated (with traces). Kept so detection can re-attach traces. */
  const [generated, setGenerated] = useState<DisplayToken[]>([]);
  /** Tokens currently displayed (generated, or re-tokenised after detection / editing). */
  const [tokens, setTokens] = useState<DisplayToken[]>([]);
  const [text, setText] = useState('');
  const [stats, setStats] = useState<OutputStats | null>(null);
  const [editing, setEditing] = useState(false);
  /** Set when the user changes the text; the generated token ids no longer describe it. */
  const [textEdited, setTextEdited] = useState(false);

  // ── Detection ──
  const [result, setResult] = useState<DetectionResult | null>(null);
  const [detecting, setDetecting] = useState(false);

  const scheme = schemeFor(watermark.mode);

  // ───────────────────────────────── generate ─────────────────────────────────
  const handleGenerate = useCallback(async () => {
    setGenerated([]);
    setTokens([]);
    setText('');
    setStats(null);
    setResult(null);
    setEditing(false);
    setTextEdited(false);

    try {
      const target = loadTargetFor(modelId);
      if (!llm.loaded || llm.loaded.modelId !== target.modelId || llm.loaded.device !== target.device || llm.loaded.dtype !== target.dtype) {
        await llm.load(target);
        void refreshCache(); // the download just landed in Cache Storage
      }
      const collected: DisplayToken[] = [];
      const res = await llm.generate(
        {
          prompt,
          promptMode,
          generation,
          watermark: { ...watermark, forceRedWords: parseWordList(forceRedText) },
        },
        {
          onToken: (t) => {
            const tok: DisplayToken = { id: t.tokenId, piece: t.piece, trace: t.trace };
            collected.push(tok);
            setTokens((prev) => [...prev, tok]);
          },
        },
      );
      setGenerated(collected);
      setText(res.text);
      setStats({ tokens: res.tokenIds.length, elapsedMs: res.elapsedMs, stopped: res.stopped });
    } catch {
      // The hook surfaces the error message via llm.error; nothing else to do here.
    }
  }, [llm, modelId, loadTargetFor, refreshCache, prompt, promptMode, generation, watermark, forceRedText]);

  // ───────────────────────────── model management ─────────────────────────────
  /** Download (and warm up) a model without generating anything. */
  const handleDownload = useCallback(
    async (id: string) => {
      setModelId(id);
      try {
        await llm.load(loadTargetFor(id));
      } catch {
        /* surfaced via llm.error */
      }
      void refreshCache();
    },
    [llm, loadTargetFor, refreshCache, setModelId],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteCachedModel(id);
      void refreshCache();
    },
    [refreshCache],
  );

  // ───────────────────────────────── detect ───────────────────────────────────
  const canUseGeneratedTokens = generated.length > 0 && !textEdited;

  const handleDetect = useCallback(async () => {
    if (!text.trim()) return;
    setDetecting(true);
    try {
      // 1. Get the token sequence to score.
      //    Realistic: re-tokenise the (possibly edited) text. The detector only has text.
      //    Oracle: use the exact ids the model emitted. Only possible for unedited output.
      let ids: number[];
      let pieces: string[];
      if (retokenize || !canUseGeneratedTokens) {
        ({ ids, pieces } = await llm.tokenize(text));
      } else {
        ids = generated.map((t) => t.id);
        pieces = generated.map((t) => t.piece);
      }
      // 2. Pure-function scoring with the *detector's* key and the shared scheme params.
      const r = detect(ids, { key: detectorKey, params: watermark, ignoreRepeats });
      // 3. Re-attach generation traces when the ids match what we generated.
      //    Re-tokenised text often does not round-trip exactly (merged or split pieces).
      //    Then the traces are dropped. Mismatched positions show up as spurious red tokens.
      const same = ids.length === generated.length && ids.every((id, i) => id === generated[i].id);
      setTokens(
        ids.map((id, i) => ({
          id,
          piece: pieces[i],
          trace: same ? generated[i].trace : undefined,
          score: r.perToken[i],
        })),
      );
      setResult(r);
    } catch {
      // Error surfaced via llm.error.
    } finally {
      setDetecting(false);
    }
  }, [llm, text, detectorKey, watermark, ignoreRepeats, generated, retokenize, canUseGeneratedTokens]);

  // Leaving edit mode: refresh the chips from the edited text. Scores are stale. Clear them.
  const handleToggleEdit = useCallback(async () => {
    if (!editing) {
      setEditing(true);
      return;
    }
    setEditing(false);
    setResult(null);
    if (llm.loaded) {
      try {
        const { ids, pieces } = await llm.tokenize(text);
        setTokens(ids.map((id, i) => ({ id, piece: pieces[i] })));
      } catch {
        /* keep old chips */
      }
    }
  }, [editing, llm, text]);

  const busy = llm.status === 'loading' || llm.status === 'generating';
  // Why the Detect button is disabled, shown under it. undefined means enabled.
  // Detection needs the tokenizer. Load a model first even for pasted text.
  const detectDisabledReason = useMemo(() => {
    if (!llm.loaded) return 'Load a model first. The detector needs its tokenizer.';
    if (!text.trim()) return 'Generate or paste some text to analyse.';
    if (busy) return 'Wait for generation to finish.';
    return undefined;
  }, [llm.loaded, text, busy]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          LLM <span className="gradient">Watermarking</span> Playground
        </h1>
        <p className="muted">
          Runs entirely in your browser. Generate text with a red/green-list or tournament watermark, then try to detect it. Use the right
          key, the wrong key, or text after edits.
        </p>
      </header>

      {/* Three columns: controls → output → detection. All state flows down as props;
          changes flow back up through the on* callbacks. */}
      <main className="columns">
        <ModelPanel
          llm={llm}
          modelId={modelId}
          hardware={hardware}
          cached={cached}
          onOpenPicker={() => setPickerOpen(true)}
          device={device}
          webgpuAvailable={webgpuAvailable}
          prompt={prompt}
          onPromptChange={setPrompt}
          promptMode={promptMode}
          onPromptModeChange={setPromptMode}
          watermark={watermark}
          onWatermarkChange={setWatermark}
          forceRedText={forceRedText}
          onForceRedTextChange={setForceRedText}
          generation={generation}
          onGenerationChange={setGeneration}
          onGenerate={handleGenerate}
          onStop={llm.stop}
        />

        <OutputPanel
          tokens={tokens}
          text={text}
          scheme={scheme}
          stats={stats}
          generating={llm.status === 'generating'}
          editing={editing}
          onToggleEdit={handleToggleEdit}
          onTextChange={(t) => {
            // Any edit invalidates both the oracle token ids and the previous result.
            setText(t);
            setTextEdited(true);
            setResult(null);
          }}
        />

        <DetectionPanel
          detectorKey={detectorKey}
          onDetectorKeyChange={setDetectorKey}
          ignoreRepeats={ignoreRepeats}
          onIgnoreRepeatsChange={setIgnoreRepeats}
          retokenize={retokenize}
          onRetokenizeChange={setRetokenize}
          canUseGeneratedTokens={canUseGeneratedTokens}
          canDetect={!detectDisabledReason}
          disabledReason={detectDisabledReason}
          detecting={detecting}
          onDetect={handleDetect}
          result={result}
        />
      </main>

      {/* Modal; renders nothing while closed. */}
      <ModelPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        hardware={hardware}
        cached={cached}
        selectedId={modelId}
        loadedId={llm.loaded?.modelId ?? null}
        busy={busy}
        onSelect={(id) => {
          setModelId(id);
          setPickerOpen(false);
        }}
        onDownload={(id) => {
          setPickerOpen(false);
          void handleDownload(id);
        }}
        onDelete={(id) => void handleDelete(id)}
      />

      <footer className="app-footer muted small">
        Schemes: Kirchenbauer et al., <em>A Watermark for Large Language Models</em> (ICML 2023) · Dathathri et al.,{' '}
        <em>Scalable watermarking for identifying LLM outputs</em> (SynthID-Text, Nature 2024). Models: ONNX exports from the Hugging Face Hub, run by Transformers.js.
      </footer>
    </div>
  );
}
