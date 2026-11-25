// The running call's latest connection sample, for readers outside the voice
// widget. The widget owns the one poller per call and writes each sample here,
// tagged with the time and whether the call was connected at that moment.
// Nothing clears the store: a reader shows a sample only through shownStats,
// which hides one written before or at the current join, or while not connected.
import { createStore, type Store } from "@lib/store";
import type { ConnectionStats } from "./connectionStats";

export interface LiveStats {
  readonly stats: ConnectionStats | null;
  /** Date.now() when the sample was written; 0 with no sample. */
  readonly at: number;
  /** Whether the call was connected when the sample was written; false with no sample. */
  readonly connected: boolean;
}

/** The running call's latest connection sample. Written only by the voice widget. */
export const liveStatsStore: Store<LiveStats> = createStore<LiveStats>({
  stats: null,
  at: 0,
  connected: false,
});

export function writeLiveStats(stats: ConnectionStats, connected: boolean): void {
  const at = Date.now();
  liveStatsStore.setState(() => ({ stats, at, connected }));
}

/** The sample to show: null unless the call is connected now, the sample was written while
 *  connected and after `joinedAt` (not in the same millisecond), and it is available. */
export function shownStats(
  entry: LiveStats,
  connected: boolean,
  joinedAt: number | null,
): ConnectionStats | null {
  const { stats } = entry;
  if (!connected || !entry.connected || stats === null || !stats.available) return null;
  if (joinedAt === null || entry.at <= joinedAt) return null;
  return stats;
}

/** The ping to show from a shown sample: the rounded rtt, or null for none or an rtt of 0. */
export function shownPing(shown: ConnectionStats | null): number | null {
  if (shown === null || shown.rtt <= 0) return null;
  return Math.round(shown.rtt);
}
