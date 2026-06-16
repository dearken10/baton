/**
 * Tiny standalone zustand store for Maestro UI state (M9 layout).
 *
 * Kept separate from `store.ts` so the session/project core doesn't
 * grow a UI-mode field. Two pieces of state: whether the full-screen
 * view is showing, and a setter that closes it on Esc.
 */

import { create } from 'zustand';

interface MaestroUI {
  fullScreen: boolean;
  setFullScreen: (v: boolean) => void;
  toggleFullScreen: () => void;
}

export const useMaestroUI = create<MaestroUI>((set) => ({
  fullScreen: false,
  setFullScreen: (v) => set({ fullScreen: v }),
  toggleFullScreen: () => set((s) => ({ fullScreen: !s.fullScreen })),
}));
