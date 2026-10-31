import { vi } from "vitest";
import { defaults } from "./voiceSessionMock";

// The panel reuses the voice widget's status text, which pulls in the voice
// session facade; nothing here touches a real session.
export function voiceLivekitSessionMock() {
  return defaults();
}

export async function voicePeerVerificationMock(importOriginal: <T>() => Promise<T>) {
  return {
    ...(await importOriginal<typeof import("../../src/features/voice/peerVerification")>()),
    openIdentityMismatchModal: vi.fn().mockResolvedValue(undefined),
  };
}
