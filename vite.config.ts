import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The model runs inside a Web Worker (src/worker/llm.worker.ts). Vite bundles
  // workers separately; `format: 'es'` lets the worker use `import` syntax and
  // code-split the (large) Transformers.js bundle away from the UI bundle.
  worker: { format: 'es' },
  optimizeDeps: {
    // onnxruntime-web ships pre-built WASM/WebGPU bundles that break if Vite tries to
    // pre-bundle them, so we tell the dev server to leave them alone.
    exclude: ['@huggingface/transformers'],
  },
  build: {
    target: 'es2022',
    // The Transformers.js bundle is several hundred KB; suppress the "large chunk" nag.
    chunkSizeWarningLimit: 2000,
  },
});
