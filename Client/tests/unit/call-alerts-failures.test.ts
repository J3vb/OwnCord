/**
 * The OS half of a DM call when the notifier refuses: the failure is logged at
 * debug level and never reaches the caller, and a missing server host is
 * reported as an empty one. Also which conversation a replaced ring names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RingState } from "../../src/lib/voice/callRing";

const { debug, showCall, clearCall, requestAttention, showToast } = vi.hoisted(() => ({
  debug: vi.fn(),
  showCall: vi.fn(),
  clearCall: vi.fn(),
  requestAttention: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("../../src/lib/logger", () => ({
  createLogger: () => ({ debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../src/platform/desktop", () => ({
  desktop: { notifier: { showCall, clearCall, requestAttention } },
}));
vi.mock("../../src/lib/ui/toast", () => ({ showToast }));

const { alertIncomingCall, alertMissedCall, alertSupersededCall, clearIncomingCall } =
  await import("../../src/features/direct-messages/callAlerts");
const { setChannelMutesHost } = await import("../../src/lib/prefs/channelMutes");
const { dmStore } = await import("../../src/stores/dm.store");

const ring: RingState = { channelId: 50, fromUserId: 10, fromUsername: "Otto" };

function dm(channelId: number, name: string, isGroup: boolean) {
  const user = { id: 10, username: "Otto", avatar: "", status: "online" };
  return {
    channelId,
    recipient: user,
    participants: [user],
    name,
    isGroup,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
  };
}

beforeEach(() => {
  debug.mockReset();
  showCall.mockReset().mockResolvedValue(undefined);
  clearCall.mockReset().mockResolvedValue(undefined);
  requestAttention.mockReset().mockResolvedValue(undefined);
  showToast.mockReset();
  localStorage.clear();
  setChannelMutesHost("a.example");
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});

afterEach(() => {
  setChannelMutesHost(null);
  dmStore.setState(() => ({ channels: [] }));
  vi.restoreAllMocks();
});

describe("call alerts when the notifier refuses", () => {
  it("logs a call notification that could not be shown and does not throw", async () => {
    const refusal = new Error("no notifier");
    showCall.mockRejectedValue(refusal);
    expect(() => alertIncomingCall(ring)).not.toThrow();
    await vi.waitFor(() =>
      expect(debug).toHaveBeenCalledWith("Call notification not available", refusal),
    );
  });

  it("logs an attention request that could not be made", async () => {
    const refusal = new Error("no attention");
    requestAttention.mockRejectedValue(refusal);
    alertIncomingCall(ring);
    await vi.waitFor(() =>
      expect(debug).toHaveBeenCalledWith("Attention request not available", refusal),
    );
  });

  it("logs a notification that could not be withdrawn", async () => {
    const refusal = new Error("no clear");
    clearCall.mockRejectedValue(refusal);
    clearIncomingCall(ring);
    await vi.waitFor(() =>
      expect(debug).toHaveBeenCalledWith("Call notification not withdrawn", refusal),
    );
  });
});

describe("call alerts without a known server", () => {
  it("targets an empty host for the notification click", () => {
    setChannelMutesHost(null);
    alertMissedCall(ring);
    expect(showCall).toHaveBeenCalledWith(
      "Missed call from Otto",
      "Voice call",
      { host: "", channelId: 50 },
      false,
    );
  });
});

describe("a replaced ring names its own conversation", () => {
  it("looks the group up by the ring's channel, not the first conversation", () => {
    dmStore.setState(() => ({
      channels: [dm(49, "Other group", true), dm(50, "Game night", true)],
    }));
    alertSupersededCall(ring);
    expect(showToast.mock.calls).toEqual([["Missed call in Game night", "info"]]);
  });

  it("falls back to the caller when the ring's channel is a 1:1 beside a group", () => {
    dmStore.setState(() => ({
      channels: [dm(49, "Other group", true), dm(50, "", false)],
    }));
    alertSupersededCall(ring);
    expect(showToast.mock.calls).toEqual([["Missed call from Otto", "info"]]);
  });
});
