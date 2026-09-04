# Feature tour

Every moving part of this website, what it is, and why it is here.

The README's ["Where to start reading the code"](README.md#where-to-start-reading-the-code)
answers *where things live*. This file answers *what the pieces are*. It is written to be
read top to bottom: the app's own life is the running order, so each feature is explained
at the point you first meet it.

Each entry follows the same shape:

> **Name** - what the feature is, at platform level.
> What this app uses it for, and where to look.

Boxes marked **If you know Python** give the nearest equivalent in a language you may
already have. They are analogies, not exact matches.

---

## Part 1 - Before any of your code runs

### `<script type="module">`

The browser's native module system (ESM). `type="module"` changes four things: the file
may use `import` / `export`, it is fetched with CORS, it runs in strict mode, and it is
*deferred* - it executes after the HTML is parsed. That last point is why
`document.getElementById('root')` in `src/main.tsx` always finds the div: the div exists
before the script runs.

`index.html` has exactly one such tag, and it names `src/main.tsx`. That single line is
the entry point of the whole program.

> **If you know Python** - it is the `if __name__ == "__main__":` of the page, except
> there is only ever one of them and the browser calls it for you.

### Vite

The build tool. Two very different jobs:

- **In development** (`npm run dev`) it is a server. It hands the browser your files
  almost unchanged, translating TypeScript and JSX to JavaScript one file at a time, on
  request. Nothing is bundled, so startup is instant. It also does **HMR** (hot module
  replacement): edit `styles.css` and the browser swaps the stylesheet without reloading
  the page or losing your state.
- **In production** (`npm run build`) it bundles everything into `dist/`, rewrites the
  script tag in `index.html` to point at the bundle, and splits the huge Transformers.js
  code into its own chunk so the UI can appear before the model code has downloaded.

`vite.config.ts` carries three settings worth knowing: `worker: { format: 'es' }` so the
Web Worker may use `import`, `optimizeDeps.exclude` so Vite leaves the pre-built ONNX
runtime alone, and a raised `chunkSizeWarningLimit` because the model runtime is
legitimately large.

### TypeScript

A type layer over JavaScript. The types are **erased**: they exist for the compiler and
your editor, and nothing about them survives into the browser. This is why type checking
is a *separate* command (`npm run typecheck`, i.e. `tsc --noEmit`) from building - Vite
strips the types without checking them, so a build alone would not catch a type error.

Features this codebase leans on, with an example of each:

| Feature | Where | What it buys |
| --- | --- | --- |
| **Discriminated union** | `ToWorker` / `FromWorker` in `worker/protocol.ts` | Every message has a literal `type` field. A `switch` on it narrows the object to that variant, so the compiler checks both ends of the conversation. |
| **`Extract<>`** | `worker/llm.worker.ts` | Pull one variant out of a union: `Extract<ToWorker, { type: 'generate' }>` is exactly the generate message. |
| **`Pick<>`** | `DetectionOptions` in `watermark/detect.ts` | The detector only needs four of the watermark's fields, and says so in the type. |
| **`keyof` + generics** | the `set` helper in `ui/ModelPanel.tsx` | One setter for every field: `set<K extends keyof WatermarkParams>(k: K, v: WatermarkParams[K])` keeps key and value types in step. |
| **Generic component** | `Segmented<T extends string>` in `ui/controls.tsx` | The option values and the `onChange` argument share one type parameter, so a typo in an option value is a compile error. |
| **`ReturnType<typeof …>`** | `export type LLM` in `hooks/useLLM.ts` | The hook's return type is derived from the hook, so it can never drift out of date. |
| **`import type`** | 17 places | Required by `verbatimModuleSyntax`: it marks an import that exists only for types, so the bundler can delete the whole line. |

`tsconfig.json` also turns on `noUnusedLocals`, `noUnusedParameters` and
`noFallthroughCasesInSwitch` - three small rules that catch dead code and a classic
`switch` bug.

---

## Part 2 - React

### `createRoot`

React's entry point since v18. It attaches a React tree to one DOM node and enables
*concurrent rendering* - React may start rendering, pause, and resume, so a long render
does not freeze the page. `src/main.tsx` calls it once and never again.

### `StrictMode`

A development-only wrapper. It deliberately **runs your components twice** and
**mounts, unmounts and re-mounts every effect once** the first time. This is not a bug:
it is a test. Code that survives it is code with no accidental state left over between
runs, which is what concurrent rendering requires. It disappears entirely in production
builds.

This is why every `useEffect` in the codebase returns a cleanup function that genuinely
undoes what the effect did - `worker.terminate()` in `useLLM`, `removeEventListener` in
`Help`.

### JSX

HTML-looking syntax that compiles to plain function calls. `<App />` becomes
`jsx(App, {})`. With `"jsx": "react-jsx"` in `tsconfig.json` (the *automatic runtime*)
you do not even need to import React to write it.

### Components, props, and "controlled" inputs

A component is a function that takes props and returns elements. Data flows **one way**:
down through props, back up through callbacks.

Every input in this app is **controlled**: its `value` comes from React state and its
`onChange` reports upward. The DOM never holds the truth. That is what makes it possible
for the detector on the right to use the same `γ` and `h` the generator on the left is
set to - both read one object owned by `App`.

The alternative, an *uncontrolled* input, keeps its value inside the DOM node and you
read it when you need it. Simpler for a single form, useless here.

### `useState`

Holds a value across renders and re-renders the component when it changes.

Two details this app uses:

- **Lazy initialiser.** `useState(() => …)` runs the function only on the first render.
  `usePersistent` in `App.tsx` uses it so `localStorage` is read once at startup, not on
  every keystroke.
- **Updater form.** `setTokens(prev => [...prev, tok])` computes from the previous value
  instead of a captured one. Token streaming needs this: several tokens can arrive
  between renders.

### `useEffect`

Runs *after* the browser has painted. For anything that reaches outside React: timers,
subscriptions, network calls, a Web Worker. The returned function is the cleanup, and it
runs before the next effect and on unmount.

The dependency array decides when it re-runs. `[]` means "once on mount" - that is how
`useLLM` creates exactly one worker for the life of the page.

### `useLayoutEffect`

The same thing, but it runs **before** the browser paints, and React waits for it. The
rule of thumb: use `useEffect` unless the user would see a wrong frame.

`Help` in `ui/controls.tsx` is exactly that case. It renders the tooltip, measures it with
`getBoundingClientRect()`, then sets its position. With `useEffect` the tip would be
painted at the wrong place for one frame and visibly jump. With `useLayoutEffect` the
measurement and the move happen in the same frame, so nobody sees it.

### `useRef`

A box whose `.current` survives re-renders and **does not** trigger one when it changes.
Two distinct uses here, and it is worth seeing them as different tools:

- **A handle on a DOM node.** `<span ref={bubbleRef}>` gives `Help` the element to
  measure.
- **Mutable bookkeeping.** `useLLM` keeps the worker, the map of pending requests and the
  request counter in refs. None of them should ever cause a render - they are plumbing.

### `useMemo` and `useCallback`

`useMemo` caches a computed value; `useCallback` caches a function. Both re-run only when
their dependencies change.

The important thing is that these are usually about **identity, not speed**. In JavaScript
a fresh `() => {}` is a different value every render, so anything that compares
dependencies sees a change.

`useLLM` returns a `useMemo`-wrapped object for exactly that reason. `handleGenerate` and
`handleDetect` in `App.tsx` are `useCallback`s that list `llm` as a dependency; if the hook
returned a fresh object every render, those callbacks would be rebuilt every render too,
and so would anything depending on *them*. Note what this does **not** do: the three
panels are not wrapped in `React.memo`, so they still re-render whenever `App` does.
Stabilising a prop only pays off once something downstream actually compares it.

`ModelPicker` uses `useMemo` for the other, simpler reason - genuine cost. `assessFit()`
runs for every model in the catalogue, and the dialog re-renders on hover.

### Custom hooks

A function whose name starts with `use` and which calls other hooks. It is how you package
stateful behaviour for reuse. Two here:

- `usePersistent(key, initial)` in `App.tsx` - a `useState` that mirrors itself into
  `localStorage`.
- `useLLM()` in `hooks/useLLM.ts` - wraps the whole Web Worker conversation.

### `createPortal`

Renders children into a **different DOM node** while keeping them in the React tree - so
state, context and events still work normally, but the markup lands somewhere else.

`Help` uses it to put the tooltip in `<body>`. The reason is CSS, and it is worth
understanding because it was a real bug in this repo: an element is clipped by any
ancestor whose `overflow` is not `visible`. The tooltip used to live inside the panel, and
the collapsible sections have `overflow: hidden`, so tooltips were sliced off at the
section border. A portalled element has no such ancestor, so nothing can clip it.

### Lists, keys, fragments, conditional rendering

- **Keys** (`key={i}` on each token chip) tell React which item is which between renders,
  so it can move DOM nodes instead of rebuilding them.
- **Fragments** (`<>…</>`) group elements without adding a wrapper div. `TokenChip` needs
  this to emit a chip *and* its `<br>` elements as siblings.
- **Conditional rendering** is just `&&` and `?:` in JSX. `{open && createPortal(…)}` -
  when `open` is false the tooltip does not exist in the DOM at all.

---

## Part 3 - Remembering things between visits

The browser gives a page several places to keep data. This app uses two, for two very
different reasons.

### `localStorage` (Web Storage API)

A tiny synchronous key/value store of **strings**, scoped to the origin, with no expiry.
Roughly 5 MB. Synchronous means a read blocks the main thread - fine for a handful of
settings, wrong for anything large.

`usePersistent` stores every setting under a `wm:` prefix. Note the merge in its
initialiser: a stored object is spread over the current defaults, so adding a new field to
`WatermarkParams` does not leave returning users with it undefined.

`JSON.stringify` / `JSON.parse` do the string conversion, and the parse is wrapped in
`try/catch` because a user can edit localStorage by hand and corrupt it.

### Cache Storage API (`caches`)

A completely separate, **asynchronous** store that holds whole HTTP `Request`/`Response`
pairs. It is the store behind offline-capable sites, and it is measured in gigabytes.
Transformers.js writes the downloaded ONNX weights here, keyed by their Hugging Face URL.

`models/cache.ts` reads it directly:

- `caches.open('transformers-cache')` gets the named cache,
- `cache.keys()` lists every stored request,
- `cache.match(req)` retrieves one so its `content-length` header can be summed into a
  size,
- `cache.delete(req)` evicts a model.

The regex `URL_RE` recovers the model id from each URL, which is how the picker can say
"downloaded, 4 files, 0.54 GB on disk" without a manifest.

> **Two stores, one lesson** - pick storage by size and access pattern. Settings are tiny
> and needed synchronously at startup: `localStorage`. Model weights are enormous and
> fetched asynchronously: Cache Storage. Putting either in the other's place would break
> the app.

`describeStorageLocation()` in the same file is doing something slightly different: no
browser exposes *where on disk* it keeps this, so that function infers a likely path from
the user agent purely to show the user. It is a guess, and the code says so.

---

## Part 4 - Asking the machine about itself

`models/hardware.ts` builds a profile so the picker can say which models will run. Every
API it uses is deliberately vague, and the reason is the same in each case:
**fingerprinting**. Precise hardware details would let any site identify you, so browsers
round, clamp, or simply refuse.

### WebGPU (`navigator.gpu`)

The modern successor to WebGL: it gives a page access to the graphics chip for both
drawing and general computation. Here it is used only for computation - running a
neural network.

`navigator.gpu.requestAdapter()` returns an *adapter*, the browser's handle on a GPU, or
nothing at all if WebGPU is unavailable. From it:

- `adapter.features.has('shader-f16')` - can the GPU do 16-bit floating point? This picks
  `q4f16` weights over `q4`, which halves the download and runs faster.
- `adapter.limits.maxBufferSize` - the largest single allocation, which bounds model size.
- `adapter.info` - vendor and architecture. `description` is usually blanked for privacy.

The whole block is inside `try/catch`, because on a browser without WebGPU
`navigator.gpu` is simply `undefined`.

### `navigator.deviceMemory`

Approximate RAM in GB. Chromium clamps it to the range 0.25-8 and rounds to a power of
two, so a value of exactly `8` means "8 **or more**" - the code records that as
`deviceMemoryCapped` and the UI prints "8 GB or more". Safari and Firefox do not
implement it at all, hence the `null` case.

### `navigator.hardwareConcurrency`

Number of logical CPU cores. Also capped by some browsers. Used only as a hint in the
"Other" row.

### `navigator.storage.estimate()` (Storage API)

Returns `{ quota, usage }` in bytes: how much the origin is allowed to store, and how much
it already has. This is what lets the picker warn you before a 2 GB download fails
halfway. Both numbers are deliberately fuzzy.

### UA Client Hints (`navigator.userAgentData`)

The structured replacement for parsing the `User-Agent` string. `platform` and `mobile`
are available without asking. The code falls back to a regex over `navigator.userAgent`
where the API is missing - which is exactly the mess client hints exist to replace.

> **The pattern to take away** - every one of these is optional, capped, or absent
> somewhere. `HardwareProfile` therefore types almost every field as `| null`, and
> `assessFit()` has an explicit `'unknown'` level. Feature detection, then graceful
> degradation.

---

## Part 5 - Two threads

### Web Workers

A Web Worker is a second JavaScript thread. It has no DOM and shares no variables with the
page; the two communicate only by passing messages.

This app would be unusable without one. A model's forward pass takes tens to hundreds of
milliseconds *per token*, and downloads run to gigabytes. On the main thread that means a
page frozen solid - no scrolling, no Stop button, no repaint. In a worker the UI stays
live and the Stop button actually works.

`useLLM` creates it with:

```ts
new Worker(new URL('../worker/llm.worker.ts', import.meta.url), { type: 'module' })
```

Two things are happening in that line. `import.meta.url` is the current module's own URL,
so `new URL(relative, base)` resolves the worker path correctly whether you are in dev or
in a hashed production bundle - and Vite recognises this exact pattern and bundles the
worker as a separate entry point. `{ type: 'module' }` lets the worker file use `import`.

> **If you know Python** - it is `multiprocessing`, not `threading`: separate memory,
> talk over a queue. The GIL analogy is close too, in that the point is to get work off
> the one thread that must stay responsive.

### `postMessage` and the structured clone algorithm

Messages are **copied**, not shared, using the *structured clone algorithm*. That copies
far more than JSON can - `Map`, `Set`, `Date`, typed arrays, cyclic references - but it
cannot copy functions, and a class instance arrives as a plain object with its prototype
stripped. Most DOM objects cannot cross either.

This constraint is why `watermark/params.ts` is nothing but plain data types: those
objects cross the thread boundary on every generate call.

### A message protocol as a type

`worker/protocol.ts` declares two discriminated unions, `ToWorker` and `FromWorker`. This
is the whole conversation written down in one file. Because each variant is tagged with a
literal `type`, a `switch (msg.type)` narrows the object automatically, and adding a new
message kind produces compile errors at every place that must handle it.

### Turning messages back into promises

Messages are fire-and-forget; the UI wants `await`. `hooks/useLLM.ts` bridges the two with
a pattern worth learning:

1. Each request gets an incrementing `requestId`.
2. Before posting, the caller's `resolve` and `reject` are stored in a `Map` under that id.
3. When a reply arrives, `worker.onmessage` looks the id up and settles that promise.

`generate` also stashes an `onToken` callback beside the resolvers - so one request can
*stream* many `token` messages and still resolve once at the end with `done`. Loads have
no id (only one model can load at a time), so their waiters sit in a plain array instead.

---

## Part 6 - Running a neural network in a tab

### ONNX

An open file format for trained models: the network's operations and weights, portable
between frameworks. The catalogue points at ONNX exports on the Hugging Face Hub.

### Transformers.js

The JavaScript port of Hugging Face's `transformers`. Same names as the Python library:
`AutoTokenizer.from_pretrained`, `AutoModelForCausalLM.from_pretrained`,
`model.generate(...)`. It downloads the model, caches it, and runs it through ONNX
Runtime Web.

Pieces this app touches:

- **`apply_chat_template`** - wraps your prompt in the model's own instruction format
  (`<|im_start|>user…`). That format is baked in at training time, which is why
  "Instruction" and "Continuation" modes produce such different output.
- **`progress_callback`** - fires during download with per-file and aggregate progress;
  it drives the progress bar.
- **`InterruptableStoppingCriteria`** - a flag the generate loop checks each step. This is
  how Stop works: the worker cannot be interrupted mid-forward-pass, so it exits cleanly
  after the current one.
- **`LogitsProcessor`** - the extension point the entire watermark hangs off. See below.

### WebGPU vs WebAssembly as backends

The same ONNX model runs through one of two engines:

- **WebGPU** - on the graphics chip, roughly 10-50x faster.
- **WebAssembly (WASM)** - a portable binary instruction format that runs at near-native
  speed on the CPU. It is the fallback, and it is slow enough that the UI says so.

You can see both in `dist/` after `npm run build`: alongside the JavaScript the build
emits a 23 MB `ort-wasm-simd-threaded…wasm`, which is the CPU engine.

### Quantisation and `dtype`

Weights are normally 32-bit floats. **Quantisation** stores them with fewer bits, trading
a little accuracy for a much smaller download and faster maths. `q4` is 4-bit weights;
`q4f16` is 4-bit weights with 16-bit activations, which needs the `shader-f16` GPU feature
detected earlier. `pickDtype()` in `models/hardware.ts` makes that choice.

### Typed arrays

`Float32Array`, `Uint32Array`, `Uint8Array` are fixed-type, fixed-size arrays over raw
binary memory. Unlike a normal JS array they cannot grow and cannot hold mixed types -
which is exactly what makes them fast and what lets them be handed to WebGPU and WASM
without conversion.

Logits arrive as a `Float32Array` of one score per vocabulary entry (about 150,000 for the
larger models here, per
token). The forced-red-list mask is a `Uint8Array` holding one 0/1 byte per token id -
a byte rather than a bit, because indexing is simpler and a 150 KB array is nothing.
Candidate ids after truncation are a `Uint32Array`.

> **If you know Python** - this is `numpy`'s `dtype`. `Float32Array` is `np.float32`, and
> the reason is the same: a contiguous block of one type that C (or here, WASM and the
> GPU) can read directly.

### `BigInt`

A JavaScript number is a 64-bit float and can only represent integers exactly up to 2^53.
Model token ids are int64, so ONNX Runtime hands them back as **BigInt** - a separate
numeric type for arbitrary-precision integers, written `123n`.

`WatermarkLogitsProcessor._call` receives `bigint[][]` and converts only the last `h`
values with `Number(...)`, because converting a whole 2,000-token context every step would
be wasted work.

### `performance.now()`

A high-resolution monotonic clock, in milliseconds with a fractional part, that is immune
to the system clock changing. Used to time generation for the "12.9 tok/s" readout. Note
that browsers deliberately reduce its precision - again, an anti-fingerprinting measure.

---

## Part 7 - The maths, briefly

### Hashing (`watermark/hash.ts`)

The watermark needs a number that looks random but is *reproducible* from
`(key, previous tokens)`. Four ingredients:

- **FNV-1a** (`hashString`) turns the key text into one 32-bit integer. Small, classic,
  not cryptographic - and the file says so, noting that a production detector would use
  HMAC.
- **`mix32`** is Chris Wellons' "lowbias32" finaliser. It is a *bijection* on 32-bit
  integers with good avalanche: flip one input bit and about half the output bits flip.
- **`Math.imul`** multiplies two 32-bit integers with wraparound, which normal JS `*`
  cannot do because it goes through 64-bit floats. **`>>> 0`** forces a value back into
  unsigned 32-bit range. Every hash step here ends with one or the other.
- **The golden-ratio constant** `0x9e3779b9` is the standard odd multiplier for
  decorrelating consecutive integers, so neighbouring token ids do not produce similar
  hashes.

`hashContext` folds the previous tokens in one at a time, scrambling between each, so
context `[A, B]` and `[B, A]` give different seeds.

### A seeded PRNG

`makeRng` is **mulberry32**, a tiny deterministic generator. Give the seed box a value and
a run is exactly reproducible; leave it blank and it is seeded from `Math.random()`.

Keep the two random sources straight: the **key** decides which tokens are favoured; this
**RNG** decides which of the favoured ones actually gets drawn.

### Softmax, top-k, top-p, and the draw (`watermark/sampling.ts`)

- **Softmax with temperature** turns logits into probabilities. The implementation
  subtracts the maximum first - the standard trick to stop `exp()` overflowing. A nice
  side effect: a `-Infinity` logit becomes exactly `0`, so hard-red-listed tokens drop out
  with no special case.
- **Top-k** keeps the k most likely tokens. Doing this by sorting 150,000 entries every
  step would be slow, so `topKIndices` uses a **size-k min-heap**: O(V log k) instead of
  O(V log V). The heap root is the smallest kept value, and almost every token fails to
  beat it after the first few thousand.
- **Top-p (nucleus)** keeps the smallest prefix of the sorted list whose probabilities
  reach p.
- **`sampleFrom`** is inverse-CDF sampling: draw `r` in [0,1), walk the sorted candidates
  accumulating probability, take the first one that passes `r`.
- **`entropyBits`** is Shannon entropy in bits. It matters conceptually: a watermark can
  only hide information where the model is *uncertain*. At a position with one obvious
  next word, no scheme can bias anything without wrecking the text. That is why lowering
  temperature weakens the watermark.

### The z-test (`watermark/detect.ts`)

Detection is a hypothesis test, not a lookup. Under "no watermark" each scored token is a
coin flip with a known bias (γ for the green list, 0.5 for tournament g-values). The
z-score asks how many standard deviations the observed rate sits above that.

`oneSidedPValue` converts z to a probability using a **series approximation of the
complementary error function** (`erfc`). It is written that way on purpose: computing
`1 - Φ(z)` directly loses all precision for large z, where the interesting answers are.
This is how the UI can print `3.2e-5` rather than `0.0000`.

---

## Part 8 - Drawing it

### CSS custom properties

`--green`, `--panel`, `--z-tooltip` and friends, declared on `:root` in `styles.css`.
Unlike a build-time variable these are live in the browser, they inherit, and they can be
read or overridden per element. Everything visual routes through them, so the palette and
the stacking order are each decided in one place.

### CSS Grid

Two-dimensional layout. The three columns are one line:

```css
grid-template-columns: minmax(300px, 340px) minmax(360px, 1fr) minmax(240px, 300px);
```

`1fr` is "one share of the leftover space", so the middle column absorbs the slack.

There is a trap here worth knowing, because it was a real bug in this repo: **`1fr` on its
own means `minmax(auto, 1fr)`**, and `auto` as a *minimum* is the item's min-content
width. A panel whose header refuses to wrap therefore forces its column wider than the
screen. The fix is `minmax(0, 1fr)`, which lets the column shrink, plus `flex-wrap` so the
content reflows into it.

`align-items: end` on `.grid3` solves a smaller version of the same thing: labels wrap to
different heights, so bottom-aligning the cells keeps the inputs on one line.

### Flexbox

One-dimensional layout - a row or a column, with `gap`, alignment, and `flex-wrap`. Used
for every small cluster: panel headers, badge rows, the segmented control.

Rule of thumb: **Grid for the page skeleton, Flex for the contents of a box.**

### Media queries

`@media (max-width: 1000px)` collapses the three columns to one. This app has exactly one
breakpoint, chosen because 300 + 360 + 240 plus gaps is about 970px - below that the
three-column layout stops fitting.

### Stacking contexts and `z-index`

The rule most people half-know. `z-index` only orders elements **within the same stacking
context**, and certain properties create a new context - `position` with a `z-index`,
`opacity` below 1, `transform`, `filter`, and others. An element inside a low context can
never rise above one outside it, no matter how large its `z-index`.

That is why this stylesheet declares `--z-modal: 100` and `--z-tooltip: 1000` as tokens on
`:root`: the ordering is a design decision made in one visible place, rather than an
accident of which rule was written last.

### `position: fixed` vs `absolute`

`absolute` positions against the nearest positioned ancestor. `fixed` positions against
the viewport and ignores ancestors entirely - which is exactly why the tooltip uses it.
Combined with the portal, the tip is anchored to the window, so no panel, border,
collapsible or modal can affect it.

### Overflow and clipping

`overflow: hidden` does not only add a scrollbar-free box - it **clips every descendant**,
including absolutely positioned ones, and no `z-index` can escape it. A subtlety worth
knowing: setting `overflow-y` alone forces the other axis to compute as `auto` rather than
`visible`, so `overflow-y: auto` clips horizontally too.

This is the single fact behind the tooltip bug that prompted this document.

### `@keyframes`

Declarative animation. Two here: `blink` for the streaming caret, and `tip-in` to fade the
tooltip in. `transition` does the simpler job for hover states.

### Odds and ends

- **`color-scheme: dark`** tells the browser this page is dark, so *native* widgets -
  scrollbars, form controls, the number-input spinners - render dark too. One line, and
  it fixes things CSS cannot reach.
- **`background-clip: text`** paints a gradient through the letterforms of the title.
- **`pointer-events: none`** makes the tooltip invisible to the mouse, so it can never
  swallow a click meant for a control underneath.
- **`white-space: pre-wrap`** preserves the spaces inside token chips. This matters more
  than it sounds: in byte-level BPE a leading space is *part of the token*, so collapsing
  whitespace would misrepresent what the model actually emitted.
- **`box-sizing: border-box`** on `*` makes `width` include padding and border. Almost
  every codebase sets this; it is the sane default the language shipped without.

---

## Part 9 - Making it usable for everyone

### ARIA roles and labels

ARIA adds semantics that HTML alone does not express, for assistive technology. Used here:
`role="radiogroup"` / `role="radio"` with `aria-checked` on the segmented control (which is
built from buttons, so it needs to *say* it is a radio group); `role="dialog"` with
`aria-modal` and `aria-labelledby` on the picker; `aria-expanded` on the collapsible
header; `role="tooltip"` on the tip.

The first rule of ARIA is not to need it - a real `<button>` or `<input type="radio">`
comes with all of this for free. It earns its place when you build a control the language
has no element for.

### `aria-live`

`<div className="output-tokens" aria-live="polite">` asks a screen reader to announce
changes to that region **without moving focus**. `polite` waits for a pause; `assertive`
interrupts. It is how streamed tokens get read out without stealing the caret from
whatever the user is doing.

### Focus and `:focus-visible`

`tabIndex={0}` puts the help bubble into the tab order, so its `onFocus` can reveal the
tooltip - a keyboard user gets exactly what a mouse user gets.

`:focus-visible` is the modern focus ring: it matches only when the browser thinks a
*visible* indicator is warranted, i.e. keyboard navigation but not a mouse click. It is
the right way to satisfy both "I hate focus rings on click" and "never remove focus
rings".

### `aria-hidden`

The opposite tool: hide something decorative from assistive tech. The g-value grid carries
`aria-hidden="true"` because 30 coloured cells are meaningless read aloud; the same
information is in the chip's text description. The tooltip is also `aria-hidden` because
the bubble's own `aria-label` already carries that sentence, and announcing it twice would
be worse than not at all.

### The `title` attribute

The browser's built-in tooltip - free, never clipped, but you cannot style it, it is slow
to appear, and it is unreliable on touch and with screen readers. This app uses it where
plain text is enough (token chip details, fit-badge reasoning) and the custom `?` bubble
where the text is long and must be readable.

---

## Part 10 - Small things worth naming

- **`Intl` via `toLocaleString`** - `formatReleased` builds a `Date` and formats it as
  "Apr 2025" in the *user's* locale. `Intl` is the internationalisation layer built into
  every browser; passing `undefined` as the locale means "use theirs". Note the explicit
  `timeZone: 'UTC'`, without which a date could render as the previous month west of
  Greenwich.
- **`Map` and `Set`** - `Map` keeps insertion order and takes any key type (used for
  request ids and for joining cached models to catalogue entries); `Set` gives O(1)
  membership (EOS token ids, and the seen-n-grams check in the detector).
- **`new URL(relative, base)`** - proper URL resolution instead of string concatenation.
- **Optional chaining `?.` and nullish coalescing `??`** - `??` differs from `||` in that
  it only falls through on `null` and `undefined`, not on `0` or `""`. With numeric
  settings that distinction is the difference between working and not.

---

## Where to see each feature

| Feature | File |
| --- | --- |
| ES module entry point | `index.html` |
| `createRoot`, `StrictMode` | `src/main.tsx` |
| `useState`, lazy init, `localStorage`, `JSON` | `usePersistent` in `src/App.tsx` |
| `useCallback`, `useMemo`, lifting state | `src/App.tsx` |
| `useLayoutEffect`, `useRef`, `createPortal`, `getBoundingClientRect` | `Help` in `src/ui/controls.tsx` |
| Generic component, controlled inputs | `Segmented`, `NumberField` in `src/ui/controls.tsx` |
| Web Worker, `postMessage`, promise bridging | `src/hooks/useLLM.ts` |
| Discriminated-union protocol | `src/worker/protocol.ts` |
| Transformers.js, ONNX, dtype, `performance.now` | `src/worker/llm.worker.ts` |
| `LogitsProcessor`, `BigInt`, typed arrays | `src/watermark/processor.ts` |
| WebGPU, `deviceMemory`, `storage.estimate`, UA hints | `src/models/hardware.ts` |
| Cache Storage API | `src/models/cache.ts` |
| `Intl` / `toLocaleString` | `formatReleased` in `src/models/catalog.ts` |
| FNV-1a, mix32, `Math.imul`, mulberry32 | `src/watermark/hash.ts` |
| Softmax, min-heap top-k, nucleus, inverse CDF, entropy | `src/watermark/sampling.ts` |
| z-test, erfc approximation | `src/watermark/detect.ts` |
| Grid, Flex, custom properties, stacking, `@keyframes` | `src/styles.css` |
| ARIA, `aria-live`, focus | `src/ui/*.tsx` |
| Vite config, worker bundling | `vite.config.ts` |
| TypeScript strictness | `tsconfig.json` |
