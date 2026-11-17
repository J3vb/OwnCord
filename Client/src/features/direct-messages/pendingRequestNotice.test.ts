import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountPendingRequestNotice } from "./pendingRequestNotice";
import {
  clearRequestPending,
  isRequestPending,
  markRequestPending,
  noteRingSent,
  pendingRequestsStore,
  resetPendingRequests,
  takeRingChannel,
} from "./pendingRequests";
import { handleChatMessage } from "../messaging/wsHandlers";
import { handleVoiceState } from "../voice/wsHandlers";
import { resetVoiceStore } from "../../stores/voice.store";
import { createReconnectClock } from "../connection/dispatchContext";
import type { DispatchWs, Payload } from "../connection/dispatchContext";
import { channelsStore } from "../../stores/channels.store";
import { dmStore } from "../../stores/dm.store";
import { resetMessagesStore } from "../../stores/messages.store";
import { dmRecipient, makeDm } from "../../../tests/helpers/dmHarness";
import { signInAs } from "../../../tests/helpers/storeSeeds";

vi.mock("../../lib/notifications", () => ({ notifyIncomingMessage: vi.fn() }));

const DM = 100;

function open(channelId: number | null): void {
  channelsStore.setState((prev) => ({ ...prev, activeChannelId: channelId }));
  channelsStore.flush();
}

function settle(): void {
  pendingRequestsStore.flush();
  dmStore.flush();
}

function messageFrom(userId: number, username: string): Payload<"chat_message"> {
  return {
    id: 900,
    channel_id: DM,
    user: { id: userId, username, avatar: null },
    content: "sure, call me",
    reply_to: null,
    attachments: [],
    timestamp: "2026-11-13T09:15:00Z",
  };
}

const ws: DispatchWs = { send: vi.fn(() => "id"), disconnect: vi.fn() };

function voiceRow(userId: number): Payload<"voice_state"> {
  return {
    channel_id: DM,
    user_id: userId,
    username: userId === 1 ? "mira" : "kai",
    muted: false,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
  };
}

let host: HTMLDivElement;
let inputSlot: HTMLDivElement;
let callBtn: HTMLButtonElement;
let videoBtn: HTMLButtonElement;
let unmount: () => void;

function notice(): HTMLElement {
  return host.querySelector('[data-testid="dm-pending-request"]') as HTMLElement;
}

/** The notice box, or null while the live region is empty. */
function box(): HTMLElement | null {
  return notice().querySelector(".dm-pending-request");
}

const HINT = (action: string): string => `${action} (kai may not have accepted your request yet)`;

beforeEach(() => {
  resetPendingRequests();
  resetMessagesStore();
  resetVoiceStore();
  signInAs({ id: 1, username: "mira", avatar: null, role: "member" }, { token: "t" });
  dmStore.setState(() => ({
    channels: [
      makeDm({
        channelId: DM,
        recipient: dmRecipient(10, "kai"),
        participants: [dmRecipient(10, "kai")],
      }),
    ],
  }));
  dmStore.flush();
  open(DM);
  host = document.createElement("div");
  inputSlot = document.createElement("div");
  host.appendChild(inputSlot);
  callBtn = document.createElement("button");
  callBtn.title = "Start Call";
  videoBtn = document.createElement("button");
  videoBtn.title = "Start Video Call";
  unmount = mountPendingRequestNotice({ inputSlot, callButtons: [callBtn, videoBtn] });
});

afterEach(() => {
  unmount();
  resetPendingRequests();
});

describe("pending message request notice", () => {
  it("keeps an empty live region above the composer while no request is known to wait", () => {
    expect(notice().getAttribute("role")).toBe("status");
    expect(notice().hidden).toBe(false);
    expect(notice().childElementCount).toBe(0);
    expect(notice().nextElementSibling).toBe(inputSlot);
    expect(callBtn.title).toBe("Start Call");
  });

  it("names the other person above the composer and hints in the call tooltips", () => {
    markRequestPending(DM);
    settle();

    expect(box()).not.toBeNull();
    expect(notice().textContent).toBe(
      "Waiting for kai to accept your message request. Calls work once they accept.",
    );
    expect(box()!.querySelector("strong")!.textContent).toBe(
      "Waiting for kai to accept your message request.",
    );
    expect(box()!.querySelector("svg")).not.toBeNull();
    expect(callBtn.title).toBe(HINT("Start Call"));
    expect(videoBtn.title).toBe(HINT("Start Video Call"));
    // A hint, never a gate: the buttons stay usable.
    for (const btn of [callBtn, videoBtn]) {
      expect(btn.disabled).toBe(false);
      expect(btn.hasAttribute("aria-disabled")).toBe(false);
    }
  });

  it("is scoped to the open DM: another conversation shows no notice", () => {
    markRequestPending(DM);
    settle();
    open(200);

    expect(box()).toBeNull();
    expect(videoBtn.title).toBe("Start Video Call");

    open(DM);
    expect(box()).not.toBeNull();
  });

  it("goes away live when the other person writes in the DM", () => {
    markRequestPending(DM);
    settle();
    expect(box()).not.toBeNull();

    // This user's own message says nothing about the request.
    handleChatMessage(createReconnectClock(), messageFrom(1, "mira"));
    settle();
    expect(box()).not.toBeNull();

    handleChatMessage(createReconnectClock(), messageFrom(10, "kai"));
    settle();

    expect(box()).toBeNull();
    expect(isRequestPending(DM)).toBe(false);
    expect(callBtn.title).toBe("Start Call");
  });

  it("goes away live when the other person joins the DM's call", () => {
    markRequestPending(DM);
    settle();

    // This user's own voice row says nothing about the request.
    handleVoiceState(ws, voiceRow(1));
    settle();
    expect(box()).not.toBeNull();

    handleVoiceState(ws, voiceRow(10));
    settle();

    expect(box()).toBeNull();
    expect(callBtn.title).toBe("Start Call");
    expect(videoBtn.title).toBe("Start Video Call");
  });

  it("teardown removes the notice and restores the tooltips", () => {
    markRequestPending(DM);
    settle();
    unmount();
    unmount = () => {};

    expect(notice()).toBeNull();
    expect(callBtn.title).toBe("Start Call");
  });
});

describe("pending request state", () => {
  it("names the DM a ring went to once, and nothing for an unknown envelope", () => {
    noteRingSent("ring-1", DM);
    expect(takeRingChannel(undefined)).toBeNull();
    expect(takeRingChannel("other")).toBeNull();
    expect(takeRingChannel("ring-1")).toBe(DM);
    expect(takeRingChannel("ring-1")).toBeNull();
  });

  it("remembers only the most recent rings", () => {
    for (let i = 0; i < 9; i++) noteRingSent(`ring-${i}`, i);
    expect(takeRingChannel("ring-0")).toBeNull();
    expect(takeRingChannel("ring-8")).toBe(8);
  });

  it("a frame that changes nothing schedules no notify", async () => {
    markRequestPending(DM);
    await Promise.resolve();
    const listener = vi.fn();
    const unsub = pendingRequestsStore.subscribe(listener);
    markRequestPending(DM);
    clearRequestPending(200);
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it("clearing an unmarked DM and marking twice leave the state as it was", () => {
    const before = pendingRequestsStore.getState();
    clearRequestPending(DM);
    expect(pendingRequestsStore.getState()).toBe(before);
    markRequestPending(DM);
    const marked = pendingRequestsStore.getState();
    markRequestPending(DM);
    expect(pendingRequestsStore.getState()).toBe(marked);
  });

  it("a session reset forgets marks and rings", () => {
    markRequestPending(DM);
    noteRingSent("ring-1", DM);
    resetPendingRequests();
    expect(pendingRequestsStore.getState().channels.size).toBe(0);
    expect(takeRingChannel("ring-1")).toBeNull();
  });
});
