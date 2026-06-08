/// <reference types="vite/client" />

import type { BatonApi } from '../../preload/index.js';

declare global {
  interface Window {
    baton: BatonApi;
  }
}

export {};
