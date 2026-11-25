import type { ConnectionStats } from "../../src/lib/voice/connectionStats";

/** An available connection sample: 18 ms, excellent, no loss; `over` wins. */
export function statsSample(over: Partial<ConnectionStats> = {}): ConnectionStats {
  return {
    rtt: 18,
    quality: "excellent",
    outRate: 0,
    inRate: 0,
    outPackets: 0,
    inPackets: 0,
    totalUp: 0,
    totalDown: 0,
    loss: 0,
    jitter: 0,
    available: true,
    ...over,
  };
}
