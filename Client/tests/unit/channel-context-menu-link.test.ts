import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attachChannelContextMenu } from "@components/channel-sidebar/context-menu";
import { authStore } from "@stores/auth.store";
import { channelsStore, type Channel } from "@stores/channels.store";
import { voiceStore } from "@stores/voice.store";
import { setChannelMutesHost } from "@lib/prefs/channelMutes";
import { parseChannelLink } from "@lib/deep-link";
import { setDeveloperMode } from "../helpers/message-actions-fixtures";

const channel: Channel = {
  id: 42,
  name: "general",
  type: "text",
  category: null,
  position: 0,
  unreadCount: 0,
  mentionCount: 0,
  lastMessageId: null,
  canSend: true,
  slowMode: 0,
  topic: "",
  nsfw: false,
  isPrivate: false,
  voiceMaxUsers: 0,
  voiceMaxVideo: 0,
};

let container: HTMLDivElement;
let ac: AbortController;
let writeText: ReturnType<typeof vi.fn>;

function signInAs(role: string): void {
  authStore.setState(() => ({
    token: "t",
    user: { id: 1, username: "tester", avatar: null, role },
    serverName: "s",
    motd: "",
    isAuthenticated: true,
  }));
}

function openMenu(onInvite?: (c: Channel) => void): void {
  const el = document.createElement("div");
  container.appendChild(el);
  attachChannelContextMenu(
    el,
    channel,
    ac.signal,
    ac.signal,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    onInvite,
  );
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
}

const item = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  localStorage.clear();
  setChannelMutesHost("chat.example:8443");
  container = document.createElement("div");
  document.body.appendChild(container);
  ac = new AbortController();
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  ac.abort();
  container.remove();
  document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());
  setChannelMutesHost(null);
  setDeveloperMode(false);
});

describe("channel context menu - Copy Link / Invite People / Copy Channel ID", () => {
  it("Copy Link puts a channel link on the clipboard that parses back", () => {
    signInAs("member");
    openMenu();
    item("ctx-copy-channel-link")!.click();

    expect(writeText).toHaveBeenCalledTimes(1);
    const link = writeText.mock.calls[0]![0] as string;
    expect(link).toBe("owncord://channel/42?host=chat.example%3A8443");
    expect(parseChannelLink(link)).toEqual({ channelId: 42, host: "chat.example:8443" });
  });

  it("offers no Copy Link on a voice channel", () => {
    signInAs("member");
    const el = document.createElement("div");
    container.appendChild(el);
    attachChannelContextMenu(el, { ...channel, type: "voice" }, ac.signal, ac.signal);
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
    expect(item("ctx-copy-channel-link")).toBeNull();
  });

  it("Open chat navigates without voice_join", () => {
    signInAs("member");
    const voice: Channel = { ...channel, id: 7, name: "lounge", type: "voice" };
    channelsStore.setState((s) => ({ ...s, channels: new Map([[7, voice]]) }));
    const joinsBefore = voiceStore.getState().currentChannelId;
    const el = document.createElement("div");
    container.appendChild(el);
    attachChannelContextMenu(el, voice, ac.signal, ac.signal);
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
    // Mark as Read and Mute stay off a voice row; Open chat is its entry.
    expect(item("ctx-mark-read")).toBeNull();
    item("ctx-open-chat")!.click();
    expect(channelsStore.getState().activeChannelId).toBe(7);
    // Joining is voiceStore.currentChannelId (set by the voice_join answer).
    expect(voiceStore.getState().currentChannelId).toBe(joinsBefore);
    expect(document.querySelector(".channel-ctx-menu")).toBeNull();
  });

  it("offers no Open chat on a text channel", () => {
    signInAs("member");
    openMenu();
    expect(item("ctx-open-chat")).toBeNull();
  });

  it("shows Invite People only to a role that can manage invites, and calls back", () => {
    signInAs("member");
    openMenu(vi.fn());
    expect(item("ctx-invite-people")).toBeNull();
    document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());

    signInAs("owner");
    const onInvite = vi.fn();
    openMenu(onInvite);
    item("ctx-invite-people")!.click();
    expect(onInvite).toHaveBeenCalledWith(channel);
  });

  it("omits Invite People when the host wired no handler", () => {
    signInAs("owner");
    openMenu();
    expect(item("ctx-invite-people")).toBeNull();
  });

  it("shows Copy Channel ID only in developer mode", () => {
    signInAs("member");
    openMenu();
    expect(item("ctx-copy-channel-id")).toBeNull();
    document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());

    setDeveloperMode(true);
    openMenu();
    item("ctx-copy-channel-id")!.click();
    expect(writeText).toHaveBeenCalledWith("42");
  });
});
