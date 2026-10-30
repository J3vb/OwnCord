import { vi } from "vitest";

// The panel reuses the voice widget's status text, which pulls in the voice
// session facade; nothing here touches a real session.
export function voiceLivekitSessionMock() {
  return {
    getRoomForStats: vi.fn().mockReturnValue(null),
    retryMicPermission: vi.fn().mockResolvedValue(undefined),
  };
}

export async function voicePeerVerificationMock(importOriginal: <T>() => Promise<T>) {
  return {
    ...(await importOriginal<typeof import("../../src/features/voice/peerVerification")>()),
    openIdentityMismatchModal: vi.fn().mockResolvedValue(undefined),
  };
}
