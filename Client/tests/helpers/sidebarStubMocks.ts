import { vi } from "vitest";

/** Factory body for `vi.mock("@lib/voice/livekitSession", ...)` in sidebar suites. */
export function rePinOnlySessionMock() {
  return { rePinPeerIdentity: vi.fn() };
}

/** Factory body for `vi.mock("@lib/net/e2eeCrypto", ...)` in sidebar suites. */
export function inertE2eeCryptoMock() {
  return { importIdentityPublicKey: vi.fn(), computeKeyFingerprint: vi.fn() };
}
