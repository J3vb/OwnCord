import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleVoiceJoinRollback, handleVoicePasswordRefusal } from "./wsHandlers";
import { closePasswordPrompt } from "./passwordPrompt";
import { noteJoinSent, resetJoinRequest } from "./joinRequest";
import { joinRetryInMs, noteJoinSucceeded } from "./joinBackoff";
import { voiceStore, resetVoiceStore, joinVoiceChannel } from "../../stores/voice.store";
import { channelsStore, setChannels } from "../../stores/channels.store";
import { setConnectionStatus } from "../../stores/ui.store";
import { showToast } from "../../lib/toast";
import type { DispatchWs, Payload } from "../connection/dispatchContext";

vi.mock("../../lib/livekitSession", () => ({
  leaveVoice: vi.fn(),
  isVoiceSessionActive: vi.fn(() => false),
  failPendingRejoin: vi.fn(),
}));
vi.mock("../../lib/toast", () => ({ showToast: vi.fn() }));

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
  handleVoiceJoinRollback(error(code), id);
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

describe("password dialog on a refused voice_join", () => {
  beforeEach(() => {
    sent = [];
    nextId = 0;
    vi.mocked(showToast).mockClear();
    resetJoinRequest();
    resetVoiceStore();
    noteJoinSucceeded();
    setConnectionStatus("connected");
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
});
