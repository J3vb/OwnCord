import { vi } from "vitest";
import { E2EEManager } from "../../src/lib/voice/livekitE2EE";
import { importPublicKey, exportPublicKey } from "@lib/net/e2eeCrypto";

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

/** A manager over a connected fake socket, with the socket's `send` spy. */
export function newManager(): {
  ws: { send: ReturnType<typeof vi.fn>; getState: () => string };
  mgr: E2EEManager;
} {
  const ws = { send: vi.fn(), getState: () => "connected" };
  return { ws, mgr: createManager(ws) };
}

/** Makes the mocked key import/export round-trip faithfully on the announced base64 string. */
export function roundTripPeerKeys(): void {
  vi.mocked(importPublicKey).mockImplementation(
    async (b64: string) => ({ type: `peer-key-${b64}` }) as unknown as CryptoKey,
  );
  vi.mocked(exportPublicKey).mockImplementation(async (key: CryptoKey) =>
    (key as unknown as { type: string }).type.replace("peer-key-", ""),
  );
}

/** Puts the mocked key import/export back to the shared constant defaults. */
export function restorePeerKeyMocks(): void {
  vi.mocked(importPublicKey).mockImplementation(
    async () => ({ type: "public" }) as unknown as CryptoKey,
  );
  vi.mocked(exportPublicKey).mockImplementation(async () => "bW9ja2VwaGVtZXJhbA==");
}
