/**
 * Tiny global theme store. Lives outside Zustand so that the initial
 * value can be read + applied synchronously at module load (before any
 * React tree mounts), which prevents a dark-flash when the user's
 * preference is 'light'.
 */

import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const LS_KEY = 'baton:theme';
const listeners = new Set<(t: Theme) => void>();

function loadInitial(): Theme {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch { /* ignore */ }
  return 'dark';
}

let current: Theme = loadInitial();

function applyToDom(t: Theme): void {
  // CSS handles the rest via `[data-theme="light"]` overrides.
  document.documentElement.dataset.theme = t;
}
applyToDom(current);

export function getTheme(): Theme { return current; }

export function setTheme(t: Theme): void {
  if (t === current) return;
  current = t;
  try { localStorage.setItem(LS_KEY, t); } catch { /* quota / disabled */ }
  applyToDom(t);
  for (const fn of listeners) fn(t);
}

export function subscribeTheme(fn: (t: Theme) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** React hook — re-renders when the theme changes. */
export function useTheme(): Theme {
  const [t, setT] = useState<Theme>(current);
  useEffect(() => subscribeTheme(setT), []);
  return t;
}
