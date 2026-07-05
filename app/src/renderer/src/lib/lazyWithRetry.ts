import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** sessionStorage key guarding against a reload loop. Survives the
 *  reload (sessionStorage persists across same-document navigations)
 *  but is scoped to the window, so a fresh launch starts clean. */
const RELOAD_FLAG = 'baton:chunk-stale-reloaded';

/**
 * `React.lazy`, but resilient to a *stale chunk*.
 *
 * Vite content-hashes every code-split chunk (e.g. `EditorPane-AbC123.js`)
 * and bakes that exact URL into the entry chunk. If the app is rebuilt or
 * updated in place while a window is still open, the running renderer keeps
 * pointing at the OLD hash — which the new build has deleted. The first
 * dynamic `import()` then 404s with "Failed to fetch dynamically imported
 * module", and because `React.lazy` caches the rejected promise the
 * component stays broken for the life of the renderer: re-rendering (the
 * crash card's "Try again") just re-hits the same dead URL, which can never
 * resolve because the hash is missing from disk.
 *
 * Recovery is a one-shot window reload: `loadFile` re-reads `index.html`
 * from disk, which references the NEW hash, so the import resolves. We guard
 * with a sessionStorage flag so a genuinely-unavailable chunk (a real
 * fetch/parse error rather than a stale hash) surfaces to the error boundary
 * instead of reloading forever.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors React.lazy's own signature
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      const mod = await factory();
      // Import worked — clear the guard so a *future* stale-chunk event
      // (after the next in-place update) is free to reload again.
      try { window.sessionStorage.removeItem(RELOAD_FLAG); } catch { /* ignore */ }
      return mod;
    } catch (err) {
      let alreadyReloaded = false;
      try { alreadyReloaded = window.sessionStorage.getItem(RELOAD_FLAG) === '1'; }
      catch { /* ignore */ }

      if (!alreadyReloaded) {
        try { window.sessionStorage.setItem(RELOAD_FLAG, '1'); } catch { /* ignore */ }
        window.location.reload();
        // Keep React showing the Suspense fallback until the reload tears
        // the page down — never resolve.
        return new Promise<{ default: T }>(() => { /* never resolves */ });
      }
      // Second failure after a reload: the chunk is really gone. Let the
      // rejection propagate to the nearest error boundary rather than loop.
      throw err;
    }
  });
}
