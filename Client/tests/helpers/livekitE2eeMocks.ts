import { vi } from "vitest";

// --- Mocks must be declared before imports ---
// The full E2EE protocol (announce verification, TOFU pinning, rotation-on-leave,
// timeout paths) is exercised end-to-end through the LiveKitSession facade in
// the livekitSession/ tests. This file is a focused smoke test of the extracted
// E2EEManager module surface.

export const mockSetKey = vi.fn();

export const mockKeyPair = {
  publicKey: { type: "public" } as unknown as CryptoKey,
  privateKey: { type: "private" } as unknown as CryptoKey,
};

export const mockIdentityKeyPair = {
  publicKey: { type: "id-public" } as unknown as CryptoKey,
  privateKey: { type: "id-private" } as unknown as CryptoKey,
};

export const mockMembers = new Map<number, { identityPublicKey: string | null }>();

export const mockVoiceState = {
  voiceUsers: new Map<number, Map<number, unknown>>(),
};

export function livekitClientMock() {
  return {
    // vitest 4 mocks honor construct semantics — `new` needs a real function, not an arrow.
    ExternalE2EEKeyProvider: vi.fn(function () {
      return {
        setKey: mockSetKey,
        getKeys: vi.fn().mockReturnValue([]),
      };
    }),
  };
}

export function netE2eeCryptoMock(keyPair: typeof mockKeyPair = mockKeyPair) {
  return {
    generateECDHKeyPair: vi.fn(async () => keyPair),
    exportPublicKey: vi.fn(async () => "bW9ja2VwaGVtZXJhbA=="),
    importPublicKey: vi.fn(async () => ({ type: "public" }) as unknown as CryptoKey),
    generateRoomKey: vi.fn(() => new Uint8Array(32)),
    roomKeyToBase64: vi.fn(() => "mock-room-key-base64"),
    wrapRoomKey: vi.fn(async () => ({ encryptedKey: "enc", iv: "iv" })),
    unwrapRoomKey: vi.fn(async () => ({ roomKey: new Uint8Array(32), epoch: 0 })),
    signEphemeralKey: vi.fn(async () => "mock-signature"),
    verifyEphemeralKeySignature: vi.fn(async () => true),
    importIdentityPublicKey: vi.fn(
      async () => ({ type: "id-public-imported" }) as unknown as CryptoKey,
    ),
    computeKeyFingerprint: vi.fn(async () => "AB12 CD34 EF56 7890"),
    computeRawKeyFingerprint: vi.fn(async () => "5E55 1234 5678 9ABC"),
  };
}

export function netIdentityMock() {
  return {
    getOrCreateIdentityKeyPair: vi.fn(async () => mockIdentityKeyPair),
    getIdentityPin: vi.fn(async () => ({ status: "unpinned" })),
    storeIdentityPin: vi.fn(async () => "stored"),
  };
}

export function authStoreMock() {
  return {
    authStore: { getState: vi.fn(() => ({ user: { id: 1 } })) },
  };
}

export function membersStoreMock() {
  return {
    membersStore: { getState: vi.fn(() => ({ members: mockMembers })) },
    memberDisplayName: (m: { username?: string }) => m.username ?? "",
  };
}

export function voiceStoreMock() {
  return {
    voiceStore: { getState: vi.fn(() => mockVoiceState) },
    setPeerVerification: vi.fn(),
    clearPeerVerification: vi.fn(),
    clearPeerVerifications: vi.fn(),
    setLocalSessionFingerprint: vi.fn(),
    setLocalSafetyNumber: vi.fn(),
  };
}

export { loggerMock } from "./loggerMock";

export async function voiceVoiceJoinTraceMock(importOriginal: <T>() => Promise<T>) {
  return {
    ...(await importOriginal<typeof import("@lib/voice/voiceJoinTrace")>()),
    markJoinMilestone: vi.fn(),
  };
}
