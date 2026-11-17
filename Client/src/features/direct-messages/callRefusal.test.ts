import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleDmChannelClose } from "./wsHandlers";
import { handleVoiceError } from "../voice/wsErrors";
import {
  isRequestPending,
  markRequestPending,
  noteRingSent,
  resetPendingRequests,
} from "./pendingRequests";
import { voiceStore, resetVoiceStore, setSwitchingTo } from "../../stores/voice.store";
import { dmStore } from "../../stores/dm.store";
import { channelsStore } from "../../stores/channels.store";
import { uiStore } from "../../stores/ui.store";
import { dmRecipient, makeDm } from "../../../tests/helpers/dmHarness";
import { signInAs } from "../../../tests/helpers/storeSeeds";
import { voiceUser } from "../../../tests/helpers/voiceUsers";
import type { Payload } from "../connection/dispatchContext";
import { noteJoinSent, resetJoinRequest } from "../voice/joinRequest";

const leaveVoice = vi.fn(async () => {});
vi.mock("../../lib/voice/livekitSession", () => ({ leaveVoice }));
vi.mock("../../lib/ui/toast", () => ({ showToast: vi.fn() }));
import { showToast } from "../../lib/ui/toast";

vi.spyOn(console, "info").mockImplementation(() => {});

const DM = 50;
const refusal: Payload<"error"> = {
  code: "CALL_REQUIRES_ACCEPTANCE",
  message: "calls work after the other person accepts your message request",
};

function inCall(channelId: number, userIds: readonly number[]): void {
  voiceStore.setState((prev) => ({
    ...prev,
    currentChannelId: channelId,
    voiceStatus: "connected" as const,
    voiceUsers: new Map([[channelId, new Map(userIds.map((id) => [id, voiceUser(id)]))]]),
  }));
  voiceStore.flush();
}

function showOnScreen(channelId: number | null, activeView: "people" | null = null): void {
  channelsStore.setState((prev) => ({ ...prev, activeChannelId: channelId }));
  uiStore.setState((prev) => ({ ...prev, activeView, settingsOpen: false }));
}

beforeEach(() => {
  resetPendingRequests();
  resetVoiceStore();
  dmStore.setState(() => ({
    channels: [makeDm({ channelId: DM, participants: [dmRecipient(10, "kai")] })],
  }));
  showOnScreen(null);
  signInAs({ id: 1, username: "mira", avatar: null, role: "member" });
  leaveVoice.mockClear();
  vi.mocked(showToast).mockClear();
});

afterEach(() => {
  resetPendingRequests();
  resetJoinRequest();
});

// Reached through the dispatcher's error chain, which calls handleVoiceError.
const handleCallRefusal = (p: Payload<"error">, id: string | undefined): boolean =>
  handleVoiceError(p, id);

describe("a refused call_ring", () => {
  it("ends the call the caller sits in alone, marks the DM as waiting and says why", async () => {
    inCall(DM, [1]);
    noteRingSent("ring-id", DM);

    expect(handleCallRefusal(refusal, "ring-id")).toBe(true);
    await vi.dynamicImportSettled();

    expect(isRequestPending(DM)).toBe(true);
    expect(voiceStore.getState().currentChannelId).toBeNull();
    // The session's own leave sends voice_leave.
    expect(leaveVoice).toHaveBeenCalledTimes(1);
    expect(leaveVoice).toHaveBeenCalledWith(true);
    // Started from elsewhere (the DM is not on screen): the toast names them.
    expect(showToast).toHaveBeenCalledWith(
      "Calls work once kai accepts your message request",
      "error",
    );
  });

  it("shows no toast while the refused DM is on screen: its notice says it", async () => {
    showOnScreen(DM);
    inCall(DM, [1]);
    noteRingSent("ring-id", DM);

    expect(handleCallRefusal(refusal, "ring-id")).toBe(true);
    await vi.dynamicImportSettled();

    expect(isRequestPending(DM)).toBe(true);
    expect(leaveVoice).toHaveBeenCalledWith(true);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("toasts when the DM is active but another view covers it", () => {
    showOnScreen(DM, "people");
    noteRingSent("ring-id", DM);

    handleCallRefusal(refusal, "ring-id");

    expect(showToast).toHaveBeenCalledWith(
      "Calls work once kai accepts your message request",
      "error",
    );
  });

  it("falls back to a generic name for a DM the list no longer has", () => {
    dmStore.setState(() => ({ channels: [] }));
    noteRingSent("ring-id", DM);

    handleCallRefusal(refusal, "ring-id");

    expect(showToast).toHaveBeenCalledWith(
      "Calls work once the other person accepts your message request",
      "error",
    );
  });

  it("leaves another call alone: only the refused DM's own room is ended", async () => {
    inCall(77, [1, 4]);
    noteRingSent("ring-id", DM);

    expect(handleCallRefusal(refusal, "ring-id")).toBe(true);
    await vi.dynamicImportSettled();

    expect(isRequestPending(DM)).toBe(true);
    expect(voiceStore.getState().currentChannelId).toBe(77);
    expect(leaveVoice).not.toHaveBeenCalled();
  });

  it("leaves the session to a join sent before the leave could run", async () => {
    inCall(DM, [1]);
    noteRingSent("ring-id", DM);

    handleCallRefusal(refusal, "ring-id");
    noteJoinSent(undefined);
    await vi.dynamicImportSettled();

    expect(leaveVoice).not.toHaveBeenCalled();
  });

  it("leaves the session alone while a switch to another channel waits on the server", async () => {
    inCall(DM, [1]);
    setSwitchingTo(77);
    voiceStore.flush();
    noteRingSent("ring-id", DM);

    expect(handleCallRefusal(refusal, "ring-id")).toBe(true);
    await vi.dynamicImportSettled();

    expect(isRequestPending(DM)).toBe(true);
    expect(voiceStore.getState().currentChannelId).toBe(DM);
    expect(voiceStore.getState().switchingTo).toBe(77);
    expect(leaveVoice).not.toHaveBeenCalled();
  });

  it("keeps a call someone else is already in", async () => {
    inCall(DM, [1, 10]);
    noteRingSent("ring-id", DM);

    handleCallRefusal(refusal, "ring-id");
    await vi.dynamicImportSettled();

    expect(voiceStore.getState().currentChannelId).toBe(DM);
    expect(leaveVoice).not.toHaveBeenCalled();
  });

  it("ignores a refusal of a ring this client did not send, and any other code", () => {
    inCall(DM, [1]);
    noteRingSent("ring-id", DM);

    expect(handleCallRefusal(refusal, "other-id")).toBe(false);
    expect(handleCallRefusal(refusal, undefined)).toBe(false);
    expect(handleCallRefusal({ code: "FORBIDDEN", message: "no" }, "ring-id")).toBe(false);

    expect(isRequestPending(DM)).toBe(false);
    expect(voiceStore.getState().currentChannelId).toBe(DM);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("a closed DM forgets that it was waiting", () => {
    markRequestPending(DM);
    handleDmChannelClose({ channel_id: DM });
    expect(isRequestPending(DM)).toBe(false);
  });
});
