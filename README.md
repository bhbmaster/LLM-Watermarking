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

## Comments for beginners

Start at the file header in `src/main.tsx`. That header is a glossary. It defines token, logits, sampling, green list, `γ`, `δ`, `h`, tournament `g`-values, and the z-test. It also lists which file to read next.

Then follow that study guide:

| File | What it teaches |
| --- | --- |
| `src/watermark/hash.ts` | How the key and previous tokens become a seed |
| `src/watermark/sampling.ts` | Temperature, top-k, top-p, and the random draw |
| `src/watermark/greenlist.ts` | Hard and soft red/green lists |
| `src/watermark/tournament.ts` | SynthID-style tournament (slow bracket and fast formula) |
| `src/watermark/detect.ts` | The z-test the right-hand panel runs |
| `src/watermark/processor.ts` | How the watermark enters `model.generate()` |
| `src/worker/llm.worker.ts` | Download and run the model off the UI thread |

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
