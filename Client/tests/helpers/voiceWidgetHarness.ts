import { vi } from "vitest";
import type { VoiceState } from "@stores/voice.store";
import { setConnectionStatus } from "@stores/ui.store";
import { resetMembersState } from "./storeResets";
import { resetChannelsState, resetVoiceState } from "./storeSeeds";

/** Reset voice, channels and members, with the socket live so controls stay enabled. */
export function resetVoiceWidgetStores(overrides: Partial<VoiceState> = {}): void {
  resetVoiceState(overrides);
  resetChannelsState();
  resetMembersState();
  setConnectionStatus("connected");
}

/** A connection stats poller whose snapshot is empty; `available` is added only when given. */
export function statsPoller(available?: boolean) {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    getStats: vi.fn().mockReturnValue({
      rtt: 0,
      quality: "excellent",
      outRate: 0,
      inRate: 0,
      outPackets: 0,
      inPackets: 0,
      totalUp: 0,
      totalDown: 0,
      ...(available === undefined ? {} : { available }),
    }),
    onUpdate: vi.fn().mockReturnValue(() => {}),
    onQualityChanged: vi.fn().mockReturnValue(() => {}),
  };
}

/** Module factory body for `vi.mock("@lib/voice/connectionStats", ...)`. */
export function connectionStatsMock(available?: boolean) {
  return {
    createConnectionStatsPoller: vi.fn().mockReturnValue(statsPoller(available)),
    formatBytes: vi.fn((v: number) => `${v} B`),
    formatRateCompact: vi.fn((v: number) => `${v} B/s`),
  };
}
