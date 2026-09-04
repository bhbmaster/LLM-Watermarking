/**
 * Model chooser: what this machine can run, what is already downloaded, and actions to
 * download, delete, or select. Opens as a modal from the left panel.
 *
 * Fit badges come from `models/hardware.ts`. Hover a badge to see the reasoning.
 * "Too big" models are hidden by default so the list is a shortlist for this device.
 * Nothing is enforced. Browser memory estimates are coarse. You can reveal everything and try.
 */

import { useMemo, useState } from 'react';
import { CATALOG, formatReleased, qualityStars, type ModelSpec } from '../models/catalog';
import { assessFit, type FitAssessment, type FitLevel, type HardwareProfile } from '../models/hardware';
import { CACHE_NAME, cacheUrlPrefix, describeStorageLocation, type CachedModel } from '../models/cache';
import { Badge, Help, Stars } from './controls';

export interface ModelPickerProps {
  open: boolean;
  onClose: () => void;
  /** Machine profile from `detectHardware()`; the list is empty until it arrives. */
  hardware: HardwareProfile | null;
  /** Models present in Cache Storage (from `listCachedModels()`). */
  cached: CachedModel[];
  /** The model the left panel currently points at. */
  selectedId: string;
  /** The model actually resident in the worker (its cache entry cannot be deleted). */
  loadedId: string | null;
  /** True while loading/generating: downloads and deletes are disabled. */
  busy: boolean;
  /** Make this the current model (no download yet). */
  onSelect: (id: string) => void;
  /** Select + download + warm up now, without generating. */
  onDownload: (id: string) => void;
  /** Remove the cached weights from the browser. */
  onDelete: (id: string) => void;
}

/** How each fit level is rendered as a badge. */
const FIT_LABEL: Record<FitLevel, { text: string; tone: 'green' | 'amber' | 'neutral' | 'red' }> = {
  fits: { text: 'fits', tone: 'green' },
  tight: { text: 'tight', tone: 'amber' },
  unknown: { text: 'unknown', tone: 'neutral' },
  'too-big': { text: 'too big', tone: 'red' },
};

export function ModelPicker(p: ModelPickerProps) {
  const [showAll, setShowAll] = useState(false);
  const cachedById = useMemo(() => new Map(p.cached.map((c) => [c.id, c])), [p.cached]);

  // Join catalog, hardware, and cache into one row per model. Memoised because assessFit
  // is called for every model and the picker re-renders on each hover.
  const rows = useMemo(() => {
    if (!p.hardware) return [];
    const hw = p.hardware;
    return CATALOG.map((spec) => ({ spec, fit: assessFit(spec, hw), cached: cachedById.get(spec.id) }));
  }, [p.hardware, cachedById]);

  if (!p.open) return null;

  // Default view = a shortlist for this machine. Anything already downloaded is always
  // shown (so it can be deleted), and the toggle reveals the rest.
  const visible = rows.filter((r) => showAll || r.cached || (r.fit.level !== 'too-big' && r.fit.level !== 'unknown'));
  const hidden = rows.length - visible.length;

  return (
    // Clicking the dimmed backdrop closes. Clicks inside the dialog do not bubble.
    <div className="modal-backdrop" onClick={p.onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="picker-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2 id="picker-title">Choose a model</h2>
          <button type="button" className="btn btn-ghost small" onClick={p.onClose}>
            Close
          </button>
        </header>

        {p.hardware && <HardwareSummary hw={p.hardware} />}

        <label className="checkbox small">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.currentTarget.checked)} />
          Show models that may not fit this machine {hidden > 0 && !showAll && <span className="muted">({hidden} hidden)</span>}
        </label>

        <ul className="model-list">
          {visible.map(({ spec, fit, cached }) => (
            <ModelRow
              key={spec.id}
              spec={spec}
              fit={fit}
              cached={cached}
              selected={spec.id === p.selectedId}
              loaded={spec.id === p.loadedId}
              busy={p.busy}
              onSelect={() => p.onSelect(spec.id)}
              onDownload={() => p.onDownload(spec.id)}
              onDelete={() => p.onDelete(spec.id)}
            />
          ))}
        </ul>

        <p className="muted small">
          Quality is MMLU 5-shot accuracy from the model card (25 = chance, about 70 = GPT-3.5 class). Sizes are the actual downloads.
          "Needs" is a conservative estimate of peak memory. Weights land in this browser's Cache Storage. They stay until you delete
          them or clear site data.
        </p>
      </div>
    </div>
  );
}

/**
 * One model. Left: name, badges, blurb, sizes. Right: actions.
 *   Select    - make it current (always available; the download happens on Generate)
 *   Download  - fetch and warm up now (only when not cached)
 *   Delete    - evict from Cache Storage (only when cached and not the loaded model)
 *               The worker still holds those buffers. Transformers.js would
 *               re-download on the next load anyway.
 */
function ModelRow(props: {
  spec: ModelSpec;
  fit: FitAssessment;
  cached: CachedModel | undefined;
  selected: boolean;
  loaded: boolean;
  busy: boolean;
  onSelect: () => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const { spec, fit, cached } = props;
  const badge = FIT_LABEL[fit.level];
  return (
    <li className={`model-row${props.selected ? ' selected' : ''}`}>
      <div className="model-main">
        <div className="model-title">
          <strong>{spec.name}</strong> <span className="muted">{spec.params}</span>
          {/* Hovering the fit badge shows the reasoning lines from assessFit(). */}
          <span className="fit-badge" title={fit.reasons.join('\n')}>
            <Badge tone={badge.tone}>{badge.text}</Badge>
          </span>
          {cached && <Badge tone="green">downloaded</Badge>}
          {props.loaded && <Badge tone="neutral">loaded</Badge>}
        </div>
        <div className="muted small">{spec.blurb}</div>
        {/* Quality + recency: MMLU as stars and a number, plus the release date. */}
        <div className="small row model-meta">
          <Stars n={qualityStars(spec.mmlu.score)} title={`Quality ${qualityStars(spec.mmlu.score)}/5 from MMLU`} />
          <span className="mono muted" title="MMLU, 5-shot accuracy (%). 25 = random guessing, about 70 = GPT-3.5 class, 85+ = frontier.">
            MMLU {spec.mmlu.approx ? '≈' : ''}
            {spec.mmlu.score}
          </span>
          <span className="muted">·</span>
          <span className="mono muted" title={`Released ${spec.released}`}>
            {formatReleased(spec.released)}
          </span>
        </div>
        <div className="muted small mono">
          {fit.downloadGB.toFixed(2)} GB download ({fit.dtype}) · needs ~{fit.needGB} GB
          {cached && cached.bytes > 0 && ` · ${(cached.bytes / 1024 ** 3).toFixed(2)} GB on disk`}
        </div>
        <div className="muted small model-where" title={cacheUrlPrefix(spec.id)}>
          {cached
            ? `On this machine: Cache Storage → ${CACHE_NAME} (${cached.files} files)`
            : `Will download to: this browser's Cache Storage → ${CACHE_NAME}`}
        </div>
      </div>
      <div className="model-actions">
        <button type="button" className={`btn small ${props.selected ? 'btn-secondary' : 'btn-primary'}`} onClick={props.onSelect} disabled={props.selected}>
          {props.selected ? 'Selected' : 'Select'}
        </button>
        {!cached && (
          <button type="button" className="btn btn-secondary small" onClick={props.onDownload} disabled={props.busy} title="Download now without generating">
            Download
          </button>
        )}
        {cached && (
          <button
            type="button"
            className="btn btn-ghost small"
            onClick={props.onDelete}
            disabled={props.busy || props.loaded}
            title={props.loaded ? 'Unload it first by loading another model' : 'Remove the cached files from this browser'}
          >
            Delete
          </button>
        )}
      </div>
    </li>
  );
}

/** What we could learn about this machine, with the caveats spelled out. */
function HardwareSummary({ hw }: { hw: HardwareProfile }) {
  const free = hw.storageQuotaGB !== null ? hw.storageQuotaGB - (hw.storageUsageGB ?? 0) : null;
  const loc = describeStorageLocation();
  return (
    <div className="hw">
      <div className="hw-title">
        This machine <Help text="Detected through browser APIs, which hide most details on purpose. RAM is capped at '8+' by Chromium and unavailable in Safari and Firefox. GPU memory is never exposed, so fit is estimated from RAM (shared with the GPU on most laptops)." />
      </div>
      <dl className="hw-grid">
        <dt>Compute</dt>
        <dd>
          {hw.webgpu ? (
            <>
              WebGPU{hw.gpuName ? ` · ${hw.gpuName}` : ''} {hw.shaderF16 ? <Badge tone="green">fp16</Badge> : <Badge tone="amber">no fp16</Badge>}
            </>
          ) : (
            <Badge tone="amber">CPU / WebAssembly only</Badge>
          )}
        </dd>
        <dt>RAM</dt>
        <dd>{hw.deviceMemoryGB === null ? 'not reported by this browser' : hw.deviceMemoryCapped ? `${hw.deviceMemoryGB} GB or more` : `${hw.deviceMemoryGB} GB`}</dd>
        <dt>Storage</dt>
        <dd>{free === null ? 'unknown' : `${free.toFixed(1)} GB available for downloads`}</dd>
        <dt>Downloads go to</dt>
        <dd className="hw-location">
          <span>
            {loc.browser}'s <strong>Cache Storage</strong>, cache <code>transformers-cache</code>, one entry per file keyed by its Hugging Face URL. Managed by the
            browser. Not in this project folder. Not loadable as plain <code>.onnx</code> files.
            <Help text="Inspect it in DevTools → Application → Cache Storage → transformers-cache. Delete models from this dialog, or with 'Clear site data'. Storage is per browser and per origin (host + port), so another browser or host re-downloads." />
          </span>
          {loc.path && <code className="hw-path">{loc.path}</code>}
        </dd>
        <dt>Other</dt>
        <dd>
          {[hw.platform, hw.cores ? `${hw.cores} cores` : null, hw.isMobile ? 'mobile' : null, hw.maxBufferGB ? `max GPU buffer ${hw.maxBufferGB} GB` : null]
            .filter(Boolean)
            .join(' · ') || '-'}
        </dd>
      </dl>
    </div>
  );
}
