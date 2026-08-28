/**
 * In-app provider usage-limits panel (BACKLOG "next up" item 1) — renderer-
 * side cache of main's `UsageSnapshot` push (`usage:snapshot`, see
 * main/usageService.ts). Deliberately separate from `@/store/store.ts`
 * (session/garden state) and from `appSettingsStore.ts` (the toggle itself
 * lives there, as `usageLimitsEnabled`) — this store only ever holds what
 * main pushes or returns, it never computes usage data itself.
 */
import { create } from 'zustand';
import type { UsageSnapshot } from '@shared/usageTypes';

const EMPTY_SNAPSHOT: UsageSnapshot = { enabled: false, providers: [], updatedAt: 0 };

interface UsageState {
  snapshot: UsageSnapshot;
  hydrate(snapshot: UsageSnapshot): void;
}

export const useUsageStore = create<UsageState>((set) => ({
  snapshot: EMPTY_SNAPSHOT,
  hydrate: (snapshot) => set({ snapshot })
}));
