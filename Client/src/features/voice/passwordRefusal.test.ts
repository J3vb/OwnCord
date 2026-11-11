import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleVoiceJoinRollback, handleVoicePasswordRefusal } from "./wsHandlers";
import { closePasswordPrompt, promptForChannelPassword, sendPasswordJoin } from "./passwordPrompt";
import { sendUserJoin } from "./joinClick";
import { noteJoinSent, resetJoinRequest } from "./joinRequest";
import { joinRetryInMs, noteJoinSucceeded } from "./joinBackoff";
import {
  voiceStore,
  resetVoiceStore,
  joinVoiceChannel,
  setVoiceStatus,
} from "../../stores/voice.store";
import { channelsStore, setChannels } from "../../stores/channels.store";
import { setConnectionStatus } from "../../stores/ui.store";
import { authStore } from "../../stores/auth.store";
import { showToast } from "../../lib/ui/toast";
import { leaveVoice } from "../../lib/voice/livekitSession";
import type { DispatchWs, Payload } from "../connection/dispatchContext";

vi.mock("../../lib/voice/livekitSession", () => ({
  leaveVoice: vi.fn(),
  isVoiceSessionActive: vi.fn(() => false),
  failPendingRejoin: vi.fn(),
}));
vi.mock("../../lib/ui/toast", () => ({ showToast: vi.fn() }));

const error = (code: Payload<"error">["code"]): Payload<"error"> => ({ code, message: "" });

let sent: { type: string; payload: unknown }[];
let nextId: number;
const ws: DispatchWs = {
  send: vi.fn((msg: { type: string; payload: unknown }) => {
    sent.push(msg);
    return `join-${++nextId}`;
  }),
  disconnect: vi.fn(),
};

/** The error chain's order: rollback first, then the password dialog. */
function refuse(code: Payload<"error">["code"], id: string | undefined): boolean {
  handleVoiceJoinRollback(ws, error(code), id);
  return handleVoicePasswordRefusal(ws, error(code), id);
}

const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>("[data-testid='channel-password-dialog']");
const input = (): HTMLInputElement =>
  document.querySelector<HTMLInputElement>("[data-testid='channel-password-input']")!;
const errorText = (): string =>
  document.querySelector("[data-testid='channel-password-error']")?.textContent ?? "";
const press = (id: string): void =>
  document.querySelector<HTMLElement>(`[data-testid='${id}']`)!.click();

async function typeAndSubmit(password: string): Promise<void> {
  input().value = password;
  input().dispatchEvent(new Event("input"));
  press("channel-password-submit");
}

async function openDialog(): Promise<void> {
  joinVoiceChannel(4);
  noteJoinSent("join-0");
  refuse("PASSWORD_REQUIRED", "join-0");
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
}

describe("password dialog on a refused voice_join", () => {
  beforeEach(() => {
    sent = [];
    nextId = 0;
    vi.mocked(showToast).mockClear();
    resetJoinRequest();
    resetVoiceStore();
    noteJoinSucceeded();
    setConnectionStatus("connected");
    authStore.setState((prev) => ({ ...prev, user: { id: 1, username: "me" } as never }));
    setChannels([
      {
        id: 4,
        name: "vault",
        type: "voice",
        category: null,
        position: 0,
        password_protected: true,
      },
    ]);
  });

  afterEach(() => {
    closePasswordPrompt();
    document.body.replaceChildren();
    channelsStore.setState((prev) => ({ ...prev, channels: new Map() }));
    authStore.setState((prev) => ({ ...prev, user: null }));
  });

  it("rolls the join back, then opens the dialog for that channel", async () => {
    joinVoiceChannel(4);
    noteJoinSent("join-0");

    expect(refuse("PASSWORD_REQUIRED", "join-0")).toBe(true);

    expect(voiceStore.getState().currentChannelId).toBeNull();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog()?.textContent).toContain("vault");
    expect(errorText()).toBe("");
    expect(showToast).not.toHaveBeenCalled();
    // The dialog is the retry, so no backoff arms.
    expect(joinRetryInMs()).toBe(0);
  });

  it("submitting re-sends the user's join with the password and closes the dialog", async () => {
    joinVoiceChannel(4);
    noteJoinSent("join-0");
    refuse("PASSWORD_REQUIRED", "join-0");
    await vi.waitFor(() => expect(dialog()).not.toBeNull());

    await typeAndSubmit("hunter2");

    expect(sent).toEqual([
      {
        type: "voice_join",
        payload: { channel_id: 4, user_initiated: true, password: "hunter2" },
      },
    ]);
    expect(voiceStore.getState().currentChannelId).toBe(4);
    expect(voiceStore.getState().voiceStatus).toBe("joining");
    expect(dialog()).toBeNull();
  });

  it("Enter submits, an empty password does not", async () => {
    joinVoiceChannel(4);
    noteJoinSent("join-0");
    refuse("PASSWORD_REQUIRED", "join-0");
    await vi.waitFor(() => expect(dialog()).not.toBeNull());

    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sent).toHaveLength(0);

    input().value = "pw";
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(sent).toHaveLength(1);
  });

  it("reopens with 'Wrong password' when the retry is refused", async () => {
    joinVoiceChannel(4);
    noteJoinSent("join-0");
    refuse("PASSWORD_REQUIRED", "join-0");
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    await typeAndSubmit("nope");

    expect(refuse("WRONG_PASSWORD", "join-1")).toBe(true);

    await vi.waitFor(() => expect(errorText()).toBe("Wrong password"));
    expect(document.querySelectorAll("[data-testid='channel-password-dialog']")).toHaveLength(1);
    expect(voiceStore.getState().currentChannelId).toBeNull();
    expect(joinRetryInMs()).toBe(0);
    // Trying again sends again.
    await typeAndSubmit("again");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
      type: "voice_join",
      payload: { channel_id: 4, user_initiated: true, password: "again" },
    });
  });

  it("says to wait when the retry is rate limited, without a toast or a backoff", async () => {
    joinVoiceChannel(4);
    noteJoinSent("join-0");
    refuse("PASSWORD_REQUIRED", "join-0");
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    await typeAndSubmit("x");

    expect(refuse("RATE_LIMITED", "join-1")).toBe(true);

    await vi.waitFor(() => expect(errorText()).toBe("Too many tries, wait a minute"));
    expect(showToast).not.toHaveBeenCalled();
    expect(joinRetryInMs()).toBe(0);
  });

  it("leaves a rate limit on an ordinary join to the generic handling", () => {
    joinVoiceChannel(4);
    noteJoinSent("join-0");

    expect(refuse("RATE_LIMITED", "join-0")).toBe(false);

    expect(dialog()).toBeNull();
    expect(joinRetryInMs()).toBeGreaterThan(0);
  });

  it("Cancel just closes the dialog and sends nothing", async () => {
    joinVoiceChannel(4);
    noteJoinSent("join-0");
    refuse("PASSWORD_REQUIRED", "join-0");
    await vi.waitFor(() => expect(dialog()).not.toBeNull());

    press("channel-password-cancel");

    expect(dialog()).toBeNull();
    expect(sent).toHaveLength(0);
    expect(voiceStore.getState().currentChannelId).toBeNull();
  });

  it("does not open for an error that answers another command or a superseded join", async () => {
    joinVoiceChannel(4);
    noteJoinSent("join-old");
    joinVoiceChannel(5);
    noteJoinSent("join-new");

    // Another command's id, an older join's id, and an id-less frame.
    expect(refuse("PASSWORD_REQUIRED", "chat-edit-7")).toBe(true);
    expect(refuse("WRONG_PASSWORD", "join-old")).toBe(true);
    expect(refuse("PASSWORD_REQUIRED", undefined)).toBe(true);

    await Promise.resolve();
    expect(dialog()).toBeNull();
    // The newer join is untouched.
    expect(voiceStore.getState().currentChannelId).toBe(5);
    expect(voiceStore.getState().voiceStatus).toBe("joining");
  });

  it("does not open for a refusal that arrives when no join is outstanding", async () => {
    noteJoinSent("join-0");
    expect(refuse("PASSWORD_REQUIRED", "join-0")).toBe(true);
    await Promise.resolve();
    expect(dialog()).toBeNull();
  });

  it("an automatic rejoin refused for its password asks once and does not loop", async () => {
    // The reconnect rejoin: no password, not user initiated, never retried by the client.
    joinVoiceChannel(4);
    noteJoinSent("join-auto");

    refuse("PASSWORD_REQUIRED", "join-auto");
    await vi.waitFor(() => expect(dialog()).not.toBeNull());

    // The same frame again (or any late duplicate) neither re-asks nor re-sends.
    refuse("PASSWORD_REQUIRED", "join-auto");
    await Promise.resolve();
    expect(document.querySelectorAll("[data-testid='channel-password-dialog']")).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(voiceStore.getState().currentChannelId).toBeNull();
    expect(joinRetryInMs()).toBe(0);
  });

  it("a sign-out while the prompt chunk loads leaves no dialog behind", async () => {
    joinVoiceChannel(4);
    noteJoinSent("join-0");
    refuse("PASSWORD_REQUIRED", "join-0");
    // Signed out before the lazy import resolves.
    authStore.setState((prev) => ({ ...prev, user: null }));
    await new Promise((r) => setTimeout(r, 50));
    expect(dialog()).toBeNull();
  });

  it("a newer join started while the prompt chunk loads leaves no dialog behind", async () => {
    joinVoiceChannel(4);
    noteJoinSent("join-0");
    refuse("PASSWORD_REQUIRED", "join-0");
    // The user clicks another channel before the lazy import resolves.
    noteJoinSent("join-9");
    await new Promise((r) => setTimeout(r, 50));
    expect(dialog()).toBeNull();
  });

  it("does not open while the socket is down", () => {
    setConnectionStatus("disconnected");
    promptForChannelPassword(ws, 4, null);
    expect(dialog()).toBeNull();
  });

  it("closes when the user starts a join of another channel, and sends nothing", async () => {
    await openDialog();
    setChannels([
      {
        id: 4,
        name: "vault",
        type: "voice",
        category: null,
        position: 0,
        password_protected: true,
      },
      { id: 5, name: "lounge", type: "voice", category: null, position: 1 },
    ]);

    joinVoiceChannel(5);
    noteJoinSent("join-other");

    expect(dialog()).toBeNull();
    expect(sent).toHaveLength(0);
    // A late submit for the old channel is refused too.
    sendPasswordJoin(ws, 4, "late");
    expect(sent).toHaveLength(0);
  });

  it("closes when its channel is deleted", async () => {
    await openDialog();
    channelsStore.setState((prev) => ({ ...prev, channels: new Map() }));
    channelsStore.flush();
    expect(dialog()).toBeNull();
    sendPasswordJoin(ws, 4, "late");
    expect(sent).toHaveLength(0);
  });

  it("backs off after a non-password refusal of a retry, and the next retry honours it", async () => {
    await openDialog();
    await typeAndSubmit("pw");

    handleVoiceJoinRollback(ws, error("FORBIDDEN"), "join-1");
    handleVoicePasswordRefusal(ws, error("FORBIDDEN"), "join-1");

    expect(joinRetryInMs()).toBeGreaterThan(0);
    sendPasswordJoin(ws, 4, "again");
    expect(sent).toHaveLength(1);
    expect(showToast).toHaveBeenCalled();
  });

  describe("for a locked channel clicked from a live call", () => {
    const inCall = { currentChannelId: 2, voiceStatus: "connected" };

    beforeEach(async () => {
      vi.mocked(leaveVoice).mockClear();
      joinVoiceChannel(2);
      setVoiceStatus("connected");
      sendUserJoin(ws, 4);
      refuse("PASSWORD_REQUIRED", "join-1");
      await vi.waitFor(() => expect(dialog()).not.toBeNull());
    });

    const callUntouched = (): void => {
      expect(voiceStore.getState()).toMatchObject(inCall);
      expect(leaveVoice).not.toHaveBeenCalled();
      expect(sent.filter((msg) => msg.type === "voice_leave")).toHaveLength(0);
    };

    it("asks for the password and leaves the call as it was", () => {
      expect(voiceStore.getState().switchingTo).toBeNull();
      callUntouched();
      expect(joinRetryInMs()).toBe(0);
    });

    it("sends the typed password as a switch that still keeps the call", async () => {
      await typeAndSubmit("hunter2");

      expect(sent.at(-1)).toEqual({
        type: "voice_join",
        payload: { channel_id: 4, user_initiated: true, password: "hunter2" },
      });
      expect(voiceStore.getState().switchingTo).toBe(4);
      callUntouched();
    });

    it("asks again after a wrong password, the call still untouched", async () => {
      await typeAndSubmit("nope");

      expect(refuse("WRONG_PASSWORD", "join-2")).toBe(true);

      await vi.waitFor(() => expect(errorText()).toBe("Wrong password"));
      expect(voiceStore.getState().switchingTo).toBeNull();
      callUntouched();
    });

    it("Cancel keeps the call", () => {
      press("channel-password-cancel");

      expect(dialog()).toBeNull();
      callUntouched();
    });

    it("sends nothing for a second submit while the first still waits", async () => {
      await typeAndSubmit("one");
      sendPasswordJoin(ws, 4, "two");

      expect(sent.filter((msg) => msg.type === "voice_join")).toHaveLength(2);
    });
  });
});
