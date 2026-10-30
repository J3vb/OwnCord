import { vi } from "vitest";

// Mock livekitSession. rePinPeerIdentity is hoisted
// so the mock factory can reference it and tests can assert re-pin was invoked.
export const { mockRePinPeerIdentity, mockGetUserLocalMute } = {
  mockRePinPeerIdentity: vi.fn(() => Promise.resolve(true)),
  mockGetUserLocalMute: vi.fn((_userId: number) => false),
};

export const { mockShowToast } = { mockShowToast: vi.fn() };

export const { fetchImageAsObjectUrlMock } = {
  fetchImageAsObjectUrlMock: vi.fn(() => Promise.resolve("data:image/png;base64,AAAA")),
};

export const { mockOpenUserProfilePopup } = {
  mockOpenUserProfilePopup: vi.fn(() => () => undefined),
};

export function voiceLivekitSessionMock() {
  return {
    setUserVolume: vi.fn(),
    getUserVolume: vi.fn(() => 1),
    getUserLocalMute: (userId: number) => mockGetUserLocalMute(userId),
    rePinPeerIdentity: mockRePinPeerIdentity,
    peerAnnouncedIdentityKey: vi.fn(() => null),
  };
}

export function uiToastMock() {
  return {
    showToast: mockShowToast,
    initToast: vi.fn(),
    teardownToast: vi.fn(),
  };
}

// Stub the identity-key crypto so the mismatch modal's fingerprint compute is
// deterministic in jsdom (real WebCrypto key import needs a valid SPKI blob).
export async function netE2eeCryptoMock(importOriginal: <T>() => Promise<T>) {
  const actual = await importOriginal<typeof import("../../src/lib/net/e2eeCrypto")>();
  return {
    ...actual,
    importIdentityPublicKey: vi.fn(() => Promise.resolve({} as CryptoKey)),
    computeKeyFingerprint: vi.fn(() => Promise.resolve("FEED FACE 1234 5678")),
  };
}

export async function listAttachmentsMock(importOriginal: <T>() => Promise<T>) {
  const actual =
    await importOriginal<typeof import("../../src/components/message-list/attachments")>();
  return { ...actual, fetchImageAsObjectUrl: fetchImageAsObjectUrlMock };
}

export function profilesOpenUserProfilePopupMock() {
  return {
    openUserProfilePopup: mockOpenUserProfilePopup,
    closeUserProfilePopup: vi.fn(),
  };
}
