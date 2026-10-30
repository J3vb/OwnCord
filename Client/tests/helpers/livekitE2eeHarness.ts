import { vi } from "vitest";
import { E2EEManager } from "../../src/lib/voice/livekitE2EE";

export const PEER_ID = 42;

export function createManager(ws: { send: ReturnType<typeof vi.fn> }): E2EEManager {
  return new E2EEManager({
    getWs: () => ws as never,
    getServerHost: () => "localhost:7880",
    getCurrentChannelId: () => 1,
  });
}

export function sendsOfType(ws: { send: ReturnType<typeof vi.fn> }, type: string): unknown[] {
  return ws.send.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === type);
}
