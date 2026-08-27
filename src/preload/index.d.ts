import type { HarnessApi } from './index';

declare global {
  interface Window {
    api: HarnessApi;
  }
}

export {};
