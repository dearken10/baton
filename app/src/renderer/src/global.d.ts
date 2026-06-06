import type { Code24Api } from '../../preload/index.js';

declare global {
  interface Window {
    code24: Code24Api;
  }
}

export {};
