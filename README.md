# LLM Watermarking Playground

An in-browser tool to generate text with a hidden statistical watermark, then try to detect that watermark.

A **watermark** here is not a visible stamp. It is a pattern in which tokens (word pieces) the model prefers. A detector that knows a secret key can test whether that pattern is present.

The page runs a small language model in your browser. Weights download from Hugging Face into Cache Storage. Nothing is sent to an app server.

## Why this exists

Anthropic announced that Claude models would embed invisible text watermarks, using a version of Google DeepMind SynthID-Text. See [How Claude's text watermarking works](https://www.anthropic.com/news/claude-text-watermark).

This playground is a study copy of the schemes, not Claude itself. An AI assistant built it from the UI and behaviour in this video:

[https://www.youtube.com/watch?v=Cmi-1QSaptA](https://www.youtube.com/watch?v=Cmi-1QSaptA)

Comments in the source are written for a reader who does not already know how a language model writes text.

## How to launch

You need Node.js and a browser with WebGPU (Chrome is the usual choice). WASM still runs if WebGPU is missing. Generation is then very slow.

1. Open a terminal in this repository.
2. Install dependencies:

```bash
npm install
```

3. Start the dev server:

```bash
npm run dev
```

4. Open the URL Vite prints. The usual address is `http://localhost:5173`.

5. Pick a model that fits this machine.
6. Press **Download model & generate** (or **Generate** if the model is already loaded).
7. Press **Detect watermark** on the right.

The first download can be hundreds of megabytes. Later visits reuse the browser cache.

Other scripts:

```bash
npm run typecheck
npm run build
npm run preview
```

## What you see

Three columns:

- **Left.** Model, prompt, watermark mode, and parameters (`γ`, `δ`, `h`, key, tournament depth `m`).
- **Middle.** Generated text as one chip per token. After detection, chips are coloured by the detector score.
- **Right.** Detector. It sees text and a key. It does not see the original token ids unless you turn re-tokenise off.

Modes:

| Mode | What it does |
| --- | --- |
| None | Plain sampling. Control. Detection should give `z` near 0. |
| Hard | Kirchenbauer hard red list. Red tokens get logit `-Infinity`. They are never sampled. |
| Soft | Kirchenbauer soft list. Green tokens get logit `+δ`. |
| Tournament | SynthID-Text style. Keyed `g`-functions run a knock-out among sampled candidates. |

## Maths (short)

Both schemes share a secret **key** and a context of the last `h` tokens. A hash of `(key, last h tokens)` seeds the bias for the next token. The detector rebuilds the same seed from the text.

Skip the first `h` tokens. They have no full context. If **Score repeated n-grams once** is on, a repeated `(context, token)` pair counts once. A loop cannot inflate `z`.

Papers treat `z >= 4` as a detection. That is a one-sided p-value of about `3e-5`. The wrong key gives `z` near 0.

### Red / green list (Kirchenbauer et al., ICML 2023)

At each step the seed splits the vocabulary:

- fraction `γ` is **green** (preferred)
- fraction `1 - γ` is **red** (avoided)

Hard mode forbids red. Soft mode adds `δ` to green logits, then samples as usual.

The detector counts how many of `T` scored tokens landed on green. Under "no watermark", each hit is a coin with chance `γ`:

```
z = (#green - γ T) / sqrt(T · γ · (1 - γ))
```

### Tournament / g-values (Dathathri et al., SynthID-Text, Nature 2024)

Do not forbid words. Draw candidates from the model. Then run `m` knock-out layers. Layer `ℓ` has a keyed bit `g_ℓ(token)` in `{0, 1}`. Tokens with `g = 1` tend to win.

The detector averages those bits over scored tokens and layers. Chance is 0.5. The UI statistic is:

```
score = 1 / (m T) · Σ_t Σ_ℓ g_ℓ(x_t)
```

Under "no watermark", each `g` is a fair coin:

```
z = (mean - 0.5) · 2 · sqrt(T · m)
```

The small green/red grid above a tournament chip is the `m` bits for that token.

## Where to start reading the code

### The entry point

`index.html` is the only HTML file in the project. It holds an empty `<div id="root">` and
one script tag:

```html
<script type="module" src="/src/main.tsx"></script>
```

That tag is the entry point. Vite reads it, follows the import graph from `src/main.tsx`,
and serves the result. There is no app server and no router. One page, one script.

**`src/main.tsx` is where to start reading.** Most of that file is a comment, not code:

- The **glossary** at the top defines token, vocabulary, logits, sampling, temperature,
  green list, `γ`, `δ`, `h`, tournament `g`-values, and the z-test. Read it first if you
  have not worked with a language model before.
- The **study guide** below the glossary names the file to open next.
- Below the comment there is nothing but four imports and one call, which mounts React:

```tsx
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

From there the whole app is `src/App.tsx`.

Three files carry the shape of the program:

| File | Role |
| --- | --- |
| `index.html` | The page. One empty div, one script tag. |
| `src/main.tsx` | Glossary, study guide, and the one call that mounts React. |
| `src/App.tsx` | Owns **all** state and both workflows. Everything else is a prop or a pure function. |

### Jump 1: what happens when the page loads

`App()` in `src/App.tsx` is the only stateful component. Startup is two passes, because
React runs the render before the effects.

**First render.** Nothing has been measured yet.

1. **Restore your settings** - the `usePersistent` hook at the top of `App.tsx` reads
   `localStorage` while computing initial state, so prompt, mode, `γ`, `δ`, `h`, key and
   depth come back exactly as you left them.
2. **Fall back to a default model** - the `modelId` `useMemo` has no hardware profile yet,
   so it uses `DEFAULT_MODEL_ID` from `src/models/catalog.ts`.
3. **Draw the three columns** - `ModelPanel`, `OutputPanel`, `DetectionPanel`, plus the
   `ModelPicker` modal. All of them are controlled: they draw the props they are given and
   report changes upward.

**Then the effects run.**

4. **Start the worker** - `useLLM()` in `src/hooks/useLLM.ts` runs
   `new Worker(new URL('../worker/llm.worker.ts', import.meta.url), { type: 'module' })`.
   Its effect is registered first, so this happens before anything else. The worker comes
   up empty.
5. **Detect the machine** - `detectHardware()` in `src/models/hardware.ts` asks for a
   WebGPU adapter (and its `shader-f16` feature and buffer limits), `navigator.deviceMemory`
   and `navigator.storage.estimate()`. Browsers hide most of this on purpose, so the
   profile is deliberately vague.
6. **List what is already downloaded** - `listCachedModels()` in `src/models/cache.ts`
   walks the browser's `transformers-cache` Cache Storage and groups entries by model id.

**Second render.** `setHardware` re-runs the `modelId` memo, and `recommendModel()` in
`src/models/hardware.ts` now picks the best entry of `CATALOG` that fits this machine.
That is why the model name in the left panel can change a moment after the page appears.

Nothing is downloaded during any of this. Weights are fetched on the first Generate, not
on page load, so opening the page costs nothing.

### Jump 2: where generation happens

Pressing **Generate** starts here and ends in the watermark maths:

```
ModelPanel.tsx  (button)
  └─ App.handleGenerate()                        src/App.tsx
       ├─ llm.load(target)                       src/hooks/useLLM.ts   → postMessage {type:'load'}
       │    (skipped when this model, device and dtype are already in memory)
       │    └─ load()                            src/worker/llm.worker.ts
       │         AutoTokenizer.from_pretrained + AutoModelForCausalLM.from_pretrained,
       │         then a 1-token warm-up run so the first real request is not slow.
       │         Progress messages drive the bar in ModelPanel's StatusLine.
       └─ llm.generate(args, { onToken })        src/hooks/useLLM.ts   → postMessage {type:'generate'}
            └─ generate()                        src/worker/llm.worker.ts
                 prompt → input ids (chat template in Instruction mode)
                 model.generate({ …, do_sample: false, logits_processor })
                      └─ WatermarkLogitsProcessor._call()   ← the watermark lives here
```

**`src/watermark/processor.ts` is the file to read for generation.** `_call()` runs once
per token and is the only place the schemes meet the model:

| Step in `_call()` | Function | File |
| --- | --- | --- |
| 1. Seed from key + last `h` tokens | `seedForNext()` → `hashContext()` | `watermark/greenlist.ts`, `watermark/hash.ts` |
| 2. Bias the logits | `applyHardRedList()` / `applySoftRedList()` | `watermark/greenlist.ts` |
| 3. Temperature, top-k, top-p | `softmaxWithTemperature()`, `truncate()` | `watermark/sampling.ts` |
| 4. Tournament re-weighting | `applyTournament()` | `watermark/tournament.ts` |
| 5. Draw the token | `sampleFrom()` | `watermark/sampling.ts` |

Step 5 is worth understanding, because it explains the shape of the whole file. A
Transformers.js `LogitsProcessor` is only allowed to *change scores*; it cannot say "pick
token 4711". So after sampling, `_call()` writes `-Infinity` over every logit except the
one it chose, and the worker asks for greedy decoding (`do_sample: false`). The library's
argmax then has no choice but to return our token.

Each chosen token travels back as a message: `onStep` → worker posts `{type:'token'}` →
`worker.onmessage` in `useLLM.ts` → `onToken` in `App.handleGenerate` → `setTokens` →
a chip in `OutputPanel.tsx`.

### Jump 3: where detection happens

Pressing **Detect watermark** runs on the UI thread, not in the worker:

```
DetectionPanel.tsx  (button)
  └─ App.handleDetect()                          src/App.tsx
       ├─ get the ids to score
       │    ├─ "Re-tokenise the text" on  → llm.tokenize(text)   src/hooks/useLLM.ts
       │    │     → worker tokenize()                            src/worker/llm.worker.ts
       │    │     The detector starts from *text* and tokenises it again, exactly as a
       │    │     third party who was handed the text would have to.
       │    └─ off → reuse the ids the model actually emitted (the oracle upper bound;
       │             only offered for unedited output from this session)
       ├─ detect(ids, { key, params, ignoreRepeats })   ← the z-test lives here
       │                                                  src/watermark/detect.ts
       └─ setResult() + setTokens(… score …)  → verdict card and chip colours
```

**`src/watermark/detect.ts` is the file to read for detection.** `detect()` is a pure
function - same inputs, same result - so it can re-run instantly when you change the key
or edit the text. For every token it:

1. rebuilds the generator's seed with `seedForPosition()` (`watermark/greenlist.ts`),
   skipping the first `h` tokens, which have no full context;
2. scores it with `isGreen()` (`watermark/greenlist.ts`) or `gValue()`
   (`watermark/tournament.ts`);
3. skips a repeated `(context, token)` pair when **Score repeated n-grams once** is on;
4. turns the totals into `z` and a one-sided p-value (`oneSidedPValue()`).

The result is drawn in two places: `ResultCard` in `src/ui/DetectionPanel.tsx` for the
verdict and statistics, and `chipStyle()` / `GGrid` in `src/ui/OutputPanel.tsx` for the
chip colours and the `m`-cell g-value grid.

Notice that generation and detection call the *same* seed and scoring functions. That is
why `src/watermark/*` is plain TypeScript with no React and no Transformers.js import: the
worker and the UI thread both need it. If the two sides ever disagreed about the seed, `z`
would collapse to noise.

### The rest of the map

| File | What it teaches |
| --- | --- |
| `src/watermark/hash.ts` | How the key and previous tokens become a seed |
| `src/watermark/sampling.ts` | Temperature, top-k, top-p, and the random draw |
| `src/watermark/greenlist.ts` | Hard and soft red/green lists |
| `src/watermark/tournament.ts` | SynthID-style tournament (slow bracket and fast formula) |
| `src/watermark/detect.ts` | The z-test the right-hand panel runs |
| `src/watermark/processor.ts` | How the watermark enters `model.generate()` |
| `src/watermark/params.ts` | The parameter types and defaults the UI, the worker and the detector share |
| `src/worker/llm.worker.ts` | Download and run the model off the UI thread |
| `src/worker/protocol.ts` | The messages the page and that worker exchange |
| `src/hooks/useLLM.ts` | Turns those messages back into promises React can await |
| `src/models/catalog.ts` | Which models you can download, with size, score, date |
| `src/models/hardware.ts` | What this machine can run |
| `src/models/cache.ts` | List and delete files in the browser cache |
| `src/ui/controls.tsx` | Labelled inputs, segmented control, and the `?` help tooltip |
| `src/ui/ModelPanel.tsx` | Left column: model, prompt, mode, parameters |
| `src/ui/OutputPanel.tsx` | Middle column: one chip per token, coloured after detection |
| `src/ui/DetectionPanel.tsx` | Right column: the detector and its verdict card |
| `src/ui/ModelPicker.tsx` | The model chooser modal |
| `src/styles.css` | The single stylesheet, organised top-down with a section index |

Comments sit next to the code they describe. Hover help in the UI repeats the same terms.

## Suggested experiments

1. Mode None, then Detect. `z` near 0 (nothing was embedded).
2. Mode Soft, `δ = 4`. Detect with the same key. `z` much greater than 4. Change the detector key. `z` near 0.
3. Set temperature to 0.3. The watermark gets weaker (fewer uncertain positions).
4. Edit a few words, then Detect. `z` drops but often stays high.
5. Mode Hard. Force "Tolkien" onto the red list. The model must avoid that word.
6. Mode Tournament, depth 30. Hover a token. Compare its `g`-values to 0.5.

## Papers

- Kirchenbauer, Geiping, Wen, Katz, Miers, Goldstein. *A Watermark for Large Language Models*. ICML 2023.
- Dathathri et al. *Scalable watermarking for identifying large language model outputs* (SynthID-Text). Nature 2024.

Models are ONNX exports from the Hugging Face Hub, run by Transformers.js.
