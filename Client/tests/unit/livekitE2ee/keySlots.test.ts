import { describe, it, expect, vi, beforeEach } from "vitest";
import * as mocks from "../../helpers/livekitE2eeMocks";
import { roomKeyToBase64, wrapRoomKey } from "@lib/net/e2eeCrypto";
import { PEER_ID, newManager, sendsOfType } from "../../helpers/livekitE2eeHarness";

vi.mock("livekit-client", () => mocks.livekitClientMock());
vi.mock("@lib/net/e2eeCrypto", () => mocks.netE2eeCryptoMock());
vi.mock("@lib/net/identity", () => mocks.netIdentityMock());
vi.mock("@stores/auth.store", () => mocks.authStoreMock());
vi.mock("@stores/members.store", () => mocks.membersStoreMock());
vi.mock("@stores/voice.store", () => mocks.voiceStoreMock());
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/voice/voiceJoinTrace", (importOriginal) =>
  mocks.voiceVoiceJoinTraceMock(importOriginal),
);

const { mockSetKey, mockStageKey, mockMembers, mockVoiceState } = mocks;
const OLD_PEER = 43;

async function holderWithSlotPeer() {
  const { ws, mgr } = newManager();
  mockVoiceState.peerKeySlots.add(PEER_ID);
  await mgr.setupKeyExchange(true, 1);
  await mgr.handleAnnounce(PEER_ID, "cGVlcg==", "sig");
  mockSetKey.mockClear();
  vi.mocked(wrapRoomKey).mockClear();
  ws.send.mockClear();
  return { ws, mgr };
}

describe("E2EEManager key slots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMembers.clear();
    mockMembers.set(PEER_ID, { identityPublicKey: "peer-identity-b64" });
    mockMembers.set(OLD_PEER, { identityPublicKey: "old-identity-b64" });
    mockVoiceState.voiceUsers.clear();
    mockVoiceState.peerKeySlots.clear();
    vi.mocked(roomKeyToBase64).mockImplementation(() => "mock-room-key-base64");
  });

  it("stages a rotated key in slot 1 when every peer supports key slots", async () => {
    const { mgr } = await holderWithSlotPeer();
    await mgr.rotateKeyPeriodically();
    expect(mockStageKey).toHaveBeenCalledWith("mock-room-key-base64", 1);
    expect(mockSetKey).not.toHaveBeenCalled();
    expect(wrapRoomKey).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mgr.epoch,
      { slot: 1, stage: true },
    );
  });

  it("swaps the key in slot 0 at once while an older peer is in the call", async () => {
    const { mgr } = await holderWithSlotPeer();
    await mgr.handleAnnounce(OLD_PEER, "b2xk", "sig");
    mockSetKey.mockClear();
    vi.mocked(wrapRoomKey).mockClear();
    await mgr.rotateKeyPeriodically();
    expect(mockStageKey).not.toHaveBeenCalled();
    expect(mockSetKey).toHaveBeenCalledWith("mock-room-key-base64");
    expect(vi.mocked(wrapRoomKey).mock.calls.map((c) => c[4])).toEqual([
      { slot: 0, stage: false },
      undefined,
    ]);
  });

  it("an older client joining while the call is on slot 1 moves everyone back to slot 0", async () => {
    const { ws, mgr } = await holderWithSlotPeer();
    await mgr.rotateKeyPeriodically();
    const epochOnSlot1 = mgr.epoch;
    mockSetKey.mockClear();
    vi.mocked(wrapRoomKey).mockClear();
    ws.send.mockClear();

    await mgr.handleAnnounce(OLD_PEER, "b2xk", "sig");
    await vi.waitFor(() => expect(mgr.epoch).toBe(epochOnSlot1 + 1));
    await vi.waitFor(() => expect(sendsOfType(ws, "voice_e2ee_offer")).toHaveLength(2));
    // The slot-1 key never went to the older client: only the new slot-0 one.
    expect(vi.mocked(wrapRoomKey).mock.calls.every((c) => c[3] === mgr.epoch)).toBe(true);
    expect(mockSetKey).toHaveBeenCalledWith("mock-room-key-base64");
    const placements = new Map(vi.mocked(wrapRoomKey).mock.calls.map((c) => [c[1], c[4]]));
    expect([...placements.values()].toSorted()).toEqual([{ slot: 0, stage: false }, undefined]);
  });

  it("re-offers the current key to a returning slot peer for use at once in its slot", async () => {
    const { mgr } = await holderWithSlotPeer();
    await mgr.rotateKeyPeriodically();
    vi.mocked(wrapRoomKey).mockClear();
    await mgr.handleAnnounce(PEER_ID, "cGVlcjI=", "sig");
    expect(wrapRoomKey).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mgr.epoch,
      { slot: 1, stage: false },
    );
  });
});
