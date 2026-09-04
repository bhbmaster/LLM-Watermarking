/**
 * Inspect and manage the models Transformers.js has downloaded into the browser.
 *
 * Transformers.js stores every fetched file in the Cache Storage API under the cache
 * named `transformers-cache` (see `env.cacheKey`), keyed by the full download URL:
 *
 *     https://huggingface.co/<org>/<repo>/resolve/main/onnx/model_q4f16.onnx_data
 *
 * That lets us group cached entries by repo id, add up their sizes, and delete a model to
 * reclaim disk space — the browser has no UI of its own for this.
 */

/** Cache Storage name Transformers.js uses (`env.cacheKey`). */
export const CACHE_NAME = 'transformers-cache';
const URL_RE = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\//;

/** Prefix of every cached file URL for a repo — what you'd look up in DevTools. */
export function cacheUrlPrefix(id: string): string {
  return `https://huggingface.co/${id}/resolve/`;
}

export interface CachedModel {
  id: string;
  files: number;
  /** Sum of Content-Length headers; 0 if the browser dropped them. */
  bytes: number;
  /** Which quantised weight files are present (e.g. ["q4f16"]). */
  dtypes: string[];
}

export async function listCachedModels(): Promise<CachedModel[]> {
  if (typeof caches === 'undefined') return [];
  const cache = await caches.open(CACHE_NAME);
  const requests = await cache.keys();
  const byModel = new Map<string, CachedModel>();

  for (const req of requests) {
    const m = URL_RE.exec(req.url);
    if (!m) continue;
    const id = m[1];
    const entry = byModel.get(id) ?? { id, files: 0, bytes: 0, dtypes: [] };
    entry.files++;

    const res = await cache.match(req);
    const len = Number(res?.headers.get('content-length') ?? 0);
    if (Number.isFinite(len)) entry.bytes += len;

    const dt = /model_([a-z0-9]+)\.onnx/.exec(req.url)?.[1];
    if (dt && !entry.dtypes.includes(dt)) entry.dtypes.push(dt);

    byModel.set(id, entry);
  }
  return [...byModel.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Where those cached bytes physically live, for the "where is it downloaded to?" line
 * in the picker. Browsers don't expose this, so it's inferred from the user agent; the
 * folder contents are hashed blobs (`index`, `xxxx_0`, …) managed by the browser — not
 * files you can open with ONNX Runtime. To see them in the browser instead: DevTools →
 * Application → Cache Storage → `transformers-cache`.
 */
export interface StorageLocation {
  /** Browser family we think we're in. */
  browser: string;
  /** Best-guess on-disk path, or null when the browser doesn't use a fixed one. */
  path: string | null;
}

export function describeStorageLocation(): StorageLocation {
  const ua = navigator.userAgent;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = (nav.userAgentData?.platform ?? navigator.platform ?? '').toLowerCase();
  const isMac = platform.includes('mac');
  const isWin = platform.includes('win');
  const isLinux = platform.includes('linux') && !/android/i.test(ua);

  // Order matters: Edge and Electron UAs also contain "Chrome".
  if (/Electron/i.test(ua)) {
    // Embedded Chromium (e.g. the browser inside Cursor / VS Code): a per-app partition.
    return { browser: 'Embedded Chromium (Electron app)', path: isMac ? '~/Library/Application Support/<App>/Partitions/<partition>/Service Worker/CacheStorage/' : isWin ? '%APPDATA%\\<App>\\Partitions\\<partition>\\Service Worker\\CacheStorage\\' : '~/.config/<App>/Partitions/<partition>/Service Worker/CacheStorage/' };
  }
  if (/Edg\//i.test(ua)) {
    return { browser: 'Microsoft Edge', path: isMac ? '~/Library/Application Support/Microsoft Edge/<Profile>/Service Worker/CacheStorage/' : isWin ? '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\<Profile>\\Service Worker\\CacheStorage\\' : '~/.config/microsoft-edge/<Profile>/Service Worker/CacheStorage/' };
  }
  if (/Chrome\//i.test(ua)) {
    return { browser: 'Chrome / Chromium', path: isMac ? '~/Library/Application Support/Google/Chrome/<Profile>/Service Worker/CacheStorage/' : isWin ? '%LOCALAPPDATA%\\Google\\Chrome\\User Data\\<Profile>\\Service Worker\\CacheStorage\\' : isLinux ? '~/.config/google-chrome/<Profile>/Service Worker/CacheStorage/' : null };
  }
  if (/Firefox\//i.test(ua)) {
    return { browser: 'Firefox', path: isMac ? '~/Library/Application Support/Firefox/Profiles/<profile>/storage/default/<origin>/cache/' : isWin ? '%APPDATA%\\Mozilla\\Firefox\\Profiles\\<profile>\\storage\\default\\<origin>\\cache\\' : '~/.mozilla/firefox/<profile>/storage/default/<origin>/cache/' };
  }
  if (/Safari\//i.test(ua)) {
    return { browser: 'Safari', path: isMac ? '~/Library/Containers/com.apple.Safari/Data/Library/Caches/com.apple.Safari/WebKitCache/ (managed by WebKit)' : null };
  }
  return { browser: 'this browser', path: null };
}

/** Remove every cached file belonging to a model repo. */
export async function deleteCachedModel(id: string): Promise<void> {
  if (typeof caches === 'undefined') return;
  const cache = await caches.open(CACHE_NAME);
  const prefix = `https://huggingface.co/${id}/resolve/`;
  for (const req of await cache.keys()) {
    if (req.url.startsWith(prefix)) await cache.delete(req);
  }
}
