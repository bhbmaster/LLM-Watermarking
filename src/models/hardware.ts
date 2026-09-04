/**
 * Hardware detection: "can this machine run that model?"
 *
 * The browser hides most hardware facts. This file uses the few APIs that exist and
 * then guesses. A wrong guess is safer than allocating GPU memory to measure it:
 * a WebGPU out-of-memory error can kill the tab.
 *
 * Signals:
 *  • WebGPU adapter — if missing, only tiny models on CPU/WASM make sense
 *  • shader-f16     — if present, use the smaller q4f16 weights
 *  • deviceMemory   — Chromium only; the value 8 means "8 GB or more"
 *  • storage.estimate — hard cap: the download must fit in the browser quota
 *
 * GPU memory itself is never reported. On laptops, RAM is shared with the GPU, so
 * RAM is the proxy. See the glossary in `src/main.tsx` for WebGPU / WASM / ONNX.
 */

import { CATALOG, estimateMemoryGB, type Dtype, type ModelSpec } from './catalog';

export interface HardwareProfile {
  webgpu: boolean;
  /** Best available GPU name, e.g. "Apple M2 Pro" or "apple / metal-3" — may be null. */
  gpuName: string | null;
  shaderF16: boolean;
  maxBufferGB: number | null;
  maxStorageBindingGB: number | null;
  /** navigator.deviceMemory in GB, null if unsupported (Safari, Firefox). */
  deviceMemoryGB: number | null;
  /** True when the browser reported its cap (8): actual RAM could be far higher. */
  deviceMemoryCapped: boolean;
  cores: number | null;
  storageQuotaGB: number | null;
  storageUsageGB: number | null;
  platform: string | null;
  isMobile: boolean;
}

/** Chromium-only navigator extensions that TypeScript's DOM lib doesn't declare. */
interface NavigatorExtras {
  deviceMemory?: number;
  userAgentData?: { platform?: string; mobile?: boolean };
}

const GB = 1024 ** 3;
const toGB = (bytes: number | undefined) => (bytes === undefined ? null : Math.round((bytes / GB) * 100) / 100);

export async function detectHardware(): Promise<HardwareProfile> {
  const nav = navigator as Navigator & NavigatorExtras;

  // ── WebGPU ──
  let webgpu = false;
  let gpuName: string | null = null;
  let shaderF16 = false;
  let maxBufferGB: number | null = null;
  let maxStorageBindingGB: number | null = null;
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter) {
      webgpu = true;
      shaderF16 = adapter.features.has('shader-f16');
      maxBufferGB = toGB(adapter.limits.maxBufferSize);
      maxStorageBindingGB = toGB(adapter.limits.maxStorageBufferBindingSize);
      const info = adapter.info;
      if (info) {
        // `description` is the friendliest string but browsers often blank it for privacy.
        gpuName = info.description || [info.vendor, info.architecture].filter(Boolean).join(' / ') || null;
      }
    }
  } catch {
    /* no WebGPU */
  }

  // ── memory & CPU ──
  const deviceMemoryGB = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;
  const cores = typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null;

  // ── storage quota (Cache Storage shares it with IndexedDB etc.) ──
  let storageQuotaGB: number | null = null;
  let storageUsageGB: number | null = null;
  try {
    const est = await navigator.storage?.estimate();
    storageQuotaGB = toGB(est?.quota);
    storageUsageGB = toGB(est?.usage);
  } catch {
    /* unsupported */
  }

  const ua = navigator.userAgent;
  const isMobile = nav.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(ua);
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? null;

  return {
    webgpu,
    gpuName,
    shaderF16,
    maxBufferGB,
    maxStorageBindingGB,
    deviceMemoryGB,
    // Chromium clamps the report to the range [0.25, 8]; exactly 8 therefore means "8 or
    // more". Some embedders (e.g. Electron) report the true value, which we take at face value.
    deviceMemoryCapped: deviceMemoryGB === 8,
    cores,
    storageQuotaGB,
    storageUsageGB,
    platform,
    isMobile,
  };
}

// ─────────────────────────────────────────── fit ─────────────────────────────────────────

export type FitLevel =
  /** Comfortably within what we can see of this machine. */
  | 'fits'
  /** Probably works, but close to the limit or depends on RAM we can't observe. */
  | 'tight'
  /** We simply can't tell (e.g. large model on a machine reporting "8 GB or more"). */
  | 'unknown'
  /** Exceeds a limit we can observe (storage quota, small RAM, no GPU). */
  | 'too-big';

export interface FitAssessment {
  level: FitLevel;
  /** Which quantisation we'd load on this hardware. */
  dtype: Dtype;
  downloadGB: number;
  needGB: number;
  /** Human-readable justification lines for the UI tooltip. */
  reasons: string[];
}

/**
 * q4f16 is the default for WebGPU with fp16 shaders. Without fp16 (old GPUs, WASM) fall
 * back to q4 when the repo publishes it; otherwise q4f16 is still attempted — ORT can
 * emulate fp16 on fp32 hardware, just slower.
 */
export function pickDtype(spec: ModelSpec, hw: HardwareProfile): Dtype {
  const fp16ok = hw.webgpu && hw.shaderF16;
  if (fp16ok) return spec.sizeGB.q4f16 !== undefined ? 'q4f16' : 'q4';
  return spec.sizeGB.q4 !== undefined ? 'q4' : 'q4f16';
}

export function assessFit(spec: ModelSpec, hw: HardwareProfile): FitAssessment {
  const dtype = pickDtype(spec, hw);
  const downloadGB = spec.sizeGB[dtype] ?? 0;
  const needGB = estimateMemoryGB(spec, dtype);
  const reasons: string[] = [];

  // 1. Hard limit: the download must fit in browser storage.
  if (hw.storageQuotaGB !== null) {
    const free = hw.storageQuotaGB - (hw.storageUsageGB ?? 0);
    if (downloadGB > free) {
      reasons.push(`Needs ${downloadGB.toFixed(2)} GB of browser storage but only ${free.toFixed(1)} GB is available.`);
      return { level: 'too-big', dtype, downloadGB, needGB, reasons };
    }
  }

  // 2. No GPU: CPU/WASM. 32-bit WASM tops out at 4 GB and is slow; only tiny models are sane.
  if (!hw.webgpu) {
    reasons.push('No WebGPU: runs on the CPU via WebAssembly (very slow, 4 GB address space).');
    if (needGB <= 1.2) return { level: 'tight', dtype, downloadGB, needGB, reasons: [...reasons, 'Small enough to try on CPU.'] };
    reasons.push(`~${needGB} GB needed; too large for the CPU path.`);
    return { level: 'too-big', dtype, downloadGB, needGB, reasons };
  }

  if (!hw.shaderF16) reasons.push('GPU lacks fp16 shaders; using the larger q4 weights where available.');

  // 3. Memory budget. GPU memory is not observable; RAM is the proxy (unified on laptops).
  //    Keep ~40% headroom for the OS, the browser and the model's own runtime buffers.
  if (hw.isMobile) {
    reasons.push('Mobile browser: memory per tab is tightly limited.');
    const level: FitLevel = needGB <= 1 ? 'fits' : needGB <= 1.8 ? 'tight' : 'too-big';
    return { level, dtype, downloadGB, needGB, reasons };
  }

  if (hw.deviceMemoryGB !== null && !hw.deviceMemoryCapped) {
    const budget = hw.deviceMemoryGB * 0.6;
    reasons.push(`Machine reports ${hw.deviceMemoryGB} GB RAM → ~${budget.toFixed(1)} GB usable; model needs ~${needGB} GB.`);
    const level: FitLevel = needGB <= budget ? 'fits' : needGB <= budget * 1.25 ? 'tight' : 'too-big';
    return { level, dtype, downloadGB, needGB, reasons };
  }

  if (hw.deviceMemoryCapped) {
    // "8 GB or more": anything up to ~5 GB is safe on an 8 GB machine; beyond that it
    // depends on RAM the browser won't tell us about.
    reasons.push(`Machine reports "8 GB or more" RAM; model needs ~${needGB} GB.`);
    if (needGB <= 5) return { level: 'fits', dtype, downloadGB, needGB, reasons };
    if (needGB <= 9) return { level: 'tight', dtype, downloadGB, needGB, reasons: [...reasons, 'Fine with 16 GB+; may fail on an 8 GB machine.'] };
    return { level: 'unknown', dtype, downloadGB, needGB, reasons: [...reasons, 'Needs a 32 GB+ workstation or a large discrete GPU.'] };
  }

  // Safari / Firefox: no RAM signal at all.
  reasons.push(`This browser does not report RAM; model needs ~${needGB} GB.`);
  const level: FitLevel = needGB <= 2.5 ? 'fits' : needGB <= 5 ? 'tight' : 'unknown';
  return { level, dtype, downloadGB, needGB, reasons };
}

/**
 * A sensible first model for this machine: the largest one that clearly fits, capped at a
 * ~1.5 GB download so the first click doesn't pull multiple gigabytes. Falls back to the
 * smallest model in the catalog.
 */
export function recommendModel(hw: HardwareProfile): ModelSpec {
  const ok = CATALOG.filter((m) => {
    const fit = assessFit(m, hw);
    return (fit.level === 'fits' || (!hw.webgpu && fit.level === 'tight')) && fit.downloadGB <= 1.5;
  });
  if (ok.length === 0) return CATALOG[0];
  return ok.reduce((best, m) => (assessFit(m, hw).downloadGB > assessFit(best, hw).downloadGB ? m : best));
}
