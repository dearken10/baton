/**
 * Tiny standalone zustand store for Maestro UI state (M9 layout).
 *
 * Kept separate from `store.ts` so the session/project core doesn't
 * grow a UI-mode field. Three pieces of state:
 *  - whether the full-screen view is showing;
 *  - a setter that closes it on Esc;
 *  - the wall-clock ms of the user's most recent input event
 *    (mousemove / click / keydown). The countdown timer and the
 *    "Run now" button both read this — the chip uses it to render
 *    "ready" vs "Nm idle" vs "active".
 */

import { create } from 'zustand';

interface MaestroUI {
  fullScreen: boolean;
  setFullScreen: (v: boolean) => void;
  toggleFullScreen: () => void;
  /** Wall-clock ms of the renderer's last observed input event.
   *  Initialised to Date.now() at module load so a fresh open of the
   *  app counts as activity (no spurious "ready" right after launch). */
  lastActivityAt: number;
  markActivity: (atMs: number) => void;
}

export const useMaestroUI = create<MaestroUI>((set) => ({
  fullScreen: false,
  setFullScreen: (v) => set({ fullScreen: v }),
  toggleFullScreen: () => set((s) => ({ fullScreen: !s.fullScreen })),
  lastActivityAt: Date.now(),
  markActivity: (atMs) => set({ lastActivityAt: atMs }),
}));
