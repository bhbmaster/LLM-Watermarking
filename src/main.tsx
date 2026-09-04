/**
 * LLM Watermarking Playground - program start.
 *
 * This file only mounts the React app. Read the glossary first if you do not already
 * know how a language model writes text. Then follow the study guide below.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * GLOSSARY (no LLM knowledge assumed)
 * ════════════════════════════════════════════════════════════════════════════════════
 *
 * Language model (LLM)
 *   A program that predicts the next piece of text, given the text so far. It does not
 *   "understand" in the human sense. It assigns a score to every possible next piece,
 *   then picks one. Repeat that pick until the answer is long enough. The result looks
 *   like writing.
 *
 * Token
 *   The piece the model actually predicts. A token is often a word, a word part, a
 *   space plus a word, or punctuation. Example: "unbelievable" can be two tokens
 *   ("un" + "believable"). The model never picks letters one by one. It picks tokens.
 *   Each token has an integer id in a fixed list called the vocabulary.
 *
 * Vocabulary
 *   The full list of tokens the model knows (often 30,000 to 150,000 entries). Every
 *   next-token choice is "pick one id from this list."
 *
 * Prompt
 *   The text you give the model as input. The model then writes a continuation.
 *
 * Logits
 *   Raw scores the model outputs for every token in the vocabulary, for the next
 *   position. Higher means "the model likes this token more." They are not yet
 *   probabilities. A later step (softmax) turns them into probabilities that sum to 1.
 *
 * Sampling
 *   The act of picking the next token using those probabilities. "Greedy" always picks
 *   the highest. "Random sampling" draws like a weighted lottery, so the same prompt
 *   can yield different text.
 *
 * Temperature / top-k / top-p
 *   Knobs that change the lottery. Temperature > 1 makes unlikely tokens more likely.
 *   Top-k keeps only the k most likely tokens. Top-p keeps the smallest set of tokens
 *   whose probabilities add up to at least p. This app applies those knobs itself.
 *
 * Watermark (in this app)
 *   A hidden statistical pattern in the generated tokens. A human reader does not see
 *   a stamp. A detector that knows a secret key can test "did a model with this key
 *   write this text?" That is the point: you can later check if text came from your
 *   watermarked model, even after someone copies it.
 *
 * Secret key
 *   A password that both the generator and the detector share. The pattern depends on
 *   the key. The wrong key makes the detector see noise. The text itself does not
 *   contain the key.
 *
 * Green list / red list (Kirchenbauer et al., 2023)
 *   At each step, the key plus the last h tokens split the vocabulary into two groups.
 *   Green = preferred. Red = avoided. "Hard" mode forbids red tokens. "Soft" mode only
 *   boosts green tokens a little, so the model can still pick a red token when it is
 *   the only sensible word.
 *
 * γ (gamma) and δ (delta)
 *   γ is the green fraction (0.5 means half the vocabulary is green). δ is how hard
 *   Soft mode pushes toward green. Larger δ = stronger watermark and more change to
 *   the wording.
 *
 * h (context)
 *   How many previous tokens join the key to pick this step's green list. If you edit
 *   one word, the next h scores can go wrong, because the context changed.
 *
 * Tournament / g-value (SynthID-Text, 2024)
 *   A different watermark. The model still samples candidates, then a keyed coin-flip
 *   function g (0 or 1) runs in many layers and prefers tokens with more 1s. The
 *   detector averages those 0/1 values. Chance is 0.5. A watermark pushes the average
 *   up. The small green/red grid above each token is those layer values.
 *
 * z-score and p-value
 *   Detection is a statistics test, not a yes/no stamp on one word. The z-score asks:
 *   "how many standard deviations above chance is this green rate?" Large z (the
 *   papers use 4) means "this is very unlikely if no watermark was applied." The
 *   p-value is the same fact as a probability under "no watermark."
 *
 * WebGPU / WASM / ONNX
 *   This app runs the model in your browser. WebGPU uses the graphics chip. WASM is
 *   the slow CPU fallback. ONNX is the file format of the downloaded weights. The
 *   files go into the browser cache, not this project folder. See src/models/cache.ts.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * STUDY GUIDE: where to read
 * ════════════════════════════════════════════════════════════════════════════════════
 *
 * The entry point is index.html, which loads this file, which mounts src/App.tsx.
 * App.tsx owns every piece of state; everything else is a prop or a pure function.
 * The README section "Where to start reading the code" walks the same path and traces
 * the two call chains below, from the button click down to the maths.
 *
 *  src/watermark/hash.ts        turn the key + previous tokens into a reproducible seed
 *  src/watermark/sampling.ts    temperature, top-k, top-p, and the random draw
 *  src/watermark/greenlist.ts   hard and soft red/green lists
 *  src/watermark/tournament.ts  SynthID-style tournament (slow bracket + fast formula)
 *  src/watermark/detect.ts      the z-test the right-hand panel runs
 *  src/watermark/processor.ts   how the watermark is inserted into model.generate()
 *
 *  src/worker/llm.worker.ts     download the model, run it off the UI thread
 *  src/worker/protocol.ts       messages between the page and that worker
 *  src/hooks/useLLM.ts          React wrapper around those messages
 *
 *  src/models/catalog.ts        which models you can download, with size, score, date
 *  src/models/hardware.ts       what this machine can run
 *  src/models/cache.ts          list and delete files in the browser cache
 *
 *  src/ui/*.tsx, src/App.tsx    the three-column page
 *
 * Suggested experiments once it runs:
 *  1. Mode None, then Detect: z near 0 (control: nothing was embedded).
 *  2. Mode Soft, δ = 4, Detect with the same key: z much greater than 4.
 *     Change the detector key: z near 0.
 *  3. Set temperature to 0.3: the watermark gets weaker (fewer uncertain positions).
 *  4. Edit a few words, then Detect: z drops but often stays high.
 *  5. Mode Hard, force "Tolkien" onto the red list: the model must avoid that word.
 *  6. Mode Tournament, depth 30: hover a token and compare its g-values to 0.5.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
