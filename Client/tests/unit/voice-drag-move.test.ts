import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

vi.mock("@lib/voice/livekitSession", () => voiceSession.defaults());

const { mockOpenUserProfilePopup } = vi.hoisted(() => ({
  mockOpenUserProfilePopup: vi.fn(() => () => undefined),
}));
vi.mock("../../src/features/profiles/openUserProfilePopup", () => ({
  openUserProfilePopup: mockOpenUserProfilePopup,
  closeUserProfilePopup: vi.fn(),
}));

import { createChannelSidebar, type ChannelReorderData } from "../../src/components/ChannelSidebar";
import { channelsStore, setChannels } from "../../src/stores/channels.store";
import { authStore } from "../../src/stores/auth.store";
import { uiStore } from "../../src/stores/ui.store";
import { voiceStore, updateVoiceState } from "../../src/stores/voice.store";
import type { ReadyChannel } from "../../src/lib/types";

const SELF_ID = 99;
const TARGET_ID = 80;

/** canMove defaults to canModerate: a drag needs can_move_voice. */
function channels(canModerate: boolean, canMove: boolean = canModerate): ReadyChannel[] {
  return [
    { id: 3, name: "lobby", type: "voice", category: "Voice", position: 0 },
    { id: 4, name: "gaming", type: "voice", category: "Voice", position: 1 },
    { id: 1, name: "general", type: "text", category: "Text", position: 0 },
  ].map(
    (ch) =>
      ({
        ...ch,
        can_moderate_voice: canModerate,
        can_move_voice: canMove,
      }) as ReadyChannel,
  );
}

function joinVoice(channelId: number, userId: number, username: string): void {
  updateVoiceState({
    channel_id: channelId,
    user_id: userId,
    username,
    muted: false,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
  });
}

/** jsdom lays nothing out: give each voice channel's drop area a band of rows. */
function layOutDropAreas(container: HTMLElement): void {
  const list = container.querySelector<HTMLElement>(".channel-list");
  if (list !== null && !Object.hasOwn(list, "getBoundingClientRect")) {
    list.getBoundingClientRect = () =>
      ({ top: 0, bottom: 1000, left: 0, right: 200, width: 200, height: 1000 }) as DOMRect;
  }
  for (const el of container.querySelectorAll<HTMLElement>("[data-voice-drop-channel-id]")) {
    const top = Number(el.dataset.voiceDropChannelId) * 100;
    el.getBoundingClientRect = () =>
      ({ top, bottom: top + 50, left: 0, right: 200, width: 200, height: 50 }) as DOMRect;
  }
}

function mouse(target: EventTarget, type: string, x: number, y: number, buttons = 1): void {
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons }),
  );
}

describe("drag a voice user onto another channel", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;
  let onMove: ReturnType<typeof vi.fn<(userId: number, toChannelId: number) => void>>;
  let onReorderChannel: ReturnType<typeof vi.fn<(reorders: readonly ChannelReorderData[]) => void>>;

  function mount(
    canModerate: boolean,
    alsoInLobby: readonly number[] = [],
    canMove?: boolean,
  ): void {
    setChannels(channels(canModerate, canMove));
    joinVoice(3, TARGET_ID, "Target");
    for (const id of alsoInLobby) joinVoice(3, id, `User ${id}`);
    joinVoice(3, SELF_ID, "Me");
    sidebar = createChannelSidebar({
      onVoiceJoin: vi.fn(),
      onOpenCall: vi.fn(),
      onReorderChannel,
      onVoiceModerate: {
        onServerMute: vi.fn(),
        onServerDeafen: vi.fn(),
        onMove,
        onDisconnect: vi.fn(),
      },
    });
    sidebar.mount(container);
    layOutDropAreas(container);
  }

  function row(userId: number): HTMLElement {
    return container.querySelector(`[data-voice-uid="${userId}"]`) as HTMLElement;
  }

  /** Press on the target's row, move to (x, y), release there. */
  function dragTargetTo(x: number, y: number): void {
    const r = row(TARGET_ID);
    mouse(r, "mousedown", 10, 310);
    mouse(document, "mousemove", 30, 330);
    mouse(document, "mousemove", x, y);
    mouse(document, "mouseup", x, y, 0);
    mouse(r, "click", x, y, 0);
  }

  beforeEach(() => {
    channelsStore.setState(() => ({
      channels: new Map(),
      activeChannelId: null,
      roles: [],
      categories: [],
    }));
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: null, voiceUsers: new Map() }));
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "connected" as const }));
    authStore.setState(() => ({
      token: "tok",
      user: { id: SELF_ID, username: "Me", avatar: null, role: "admin" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    mockOpenUserProfilePopup.mockClear();
    onMove = vi.fn<(userId: number, toChannelId: number) => void>();
    onReorderChannel = vi.fn<(reorders: readonly ChannelReorderData[]) => void>();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    document.querySelectorAll(".voice-user-drag-ghost").forEach((el) => el.remove());
  });

  it("does not make rows draggable with only can_moderate_voice", () => {
    mount(true, [], false);
    expect(row(TARGET_ID).classList.contains("voice-user-draggable")).toBe(false);
    dragTargetTo(50, 420);
    expect(onMove).not.toHaveBeenCalled();
    expect(document.querySelector(".voice-user-drag-ghost")).toBeNull();
  });

  it("does not make rows draggable without either verdict", () => {
    mount(false);
    expect(row(TARGET_ID).classList.contains("voice-user-draggable")).toBe(false);
    dragTargetTo(50, 420);
    expect(onMove).not.toHaveBeenCalled();
    expect(document.querySelector(".voice-user-drag-ghost")).toBeNull();
  });

  it("makes rows draggable and sends the move with only can_move_voice", () => {
    mount(false, [], true);
    expect(row(TARGET_ID).classList.contains("voice-user-draggable")).toBe(true);
    dragTargetTo(50, 420);
    expect(onMove).toHaveBeenCalledWith(TARGET_ID, 4);
  });

  it("does not drag when both verdicts are false", () => {
    mount(false, [], false);
    expect(row(TARGET_ID).classList.contains("voice-user-draggable")).toBe(false);
    dragTargetTo(50, 420);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("never offers the signed-in user's own row", () => {
    mount(true);
    expect(row(SELF_ID).classList.contains("voice-user-draggable")).toBe(false);
  });

  it("sends the move once when dropped on another voice channel", () => {
    mount(true);
    expect(row(TARGET_ID).classList.contains("voice-user-draggable")).toBe(true);
    dragTargetTo(50, 420);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(TARGET_ID, 4);
    // The drop's trailing click does not also open the profile.
    expect(mockOpenUserProfilePopup).not.toHaveBeenCalled();
    // Nothing is left behind, and channel reordering never started.
    expect(document.querySelector(".voice-user-drag-ghost")).toBeNull();
    expect(document.querySelector(".voice-drop-target")).toBeNull();
    expect(document.body.classList.contains("voice-user-moving")).toBe(false);
    expect(document.body.classList.contains("channel-reordering")).toBe(false);
    expect(onReorderChannel).not.toHaveBeenCalled();
  });

  it("highlights the channel under the pointer while dragging", () => {
    mount(true);
    mouse(row(TARGET_ID), "mousedown", 10, 310);
    mouse(document, "mousemove", 50, 420);
    const target = container.querySelector('[data-voice-drop-channel-id="4"]');
    expect(target?.classList.contains("voice-drop-target")).toBe(true);
    expect(document.querySelector(".voice-user-drag-ghost")).not.toBeNull();
    mouse(document, "mouseup", 50, 420, 0);
    mouse(document, "click", 50, 420, 0);
  });

  it("lets the click through again when no click followed the drop", async () => {
    mount(true);
    mouse(row(TARGET_ID), "mousedown", 10, 310);
    mouse(document, "mousemove", 50, 420);
    mouse(document, "mouseup", 50, 420, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    mouse(row(TARGET_ID), "click", 10, 310, 0);
    expect(mockOpenUserProfilePopup).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when dropped back on the same channel or on empty space", () => {
    mount(true);
    dragTargetTo(50, 320);
    dragTargetTo(50, 900);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("lets a press on a draggable row close an open volume menu", async () => {
    mount(true, [81]);
    row(81).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    // The menu code loads on its first open (O-6b).
    await vi.dynamicImportSettled();
    expect(document.querySelector(".user-vol-menu")).not.toBeNull();
    // The menu arms its outside-press listener on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    mouse(row(TARGET_ID), "mousedown", 10, 310);
    mouse(row(TARGET_ID), "mouseup", 10, 310, 0);
    expect(document.querySelector(".user-vol-menu")).toBeNull();
  });

  it("ignores a channel scrolled out of the list's view", () => {
    mount(true);
    const list = container.querySelector(".channel-list") as HTMLElement;
    list.getBoundingClientRect = () =>
      ({ top: 0, bottom: 380, left: 0, right: 200, width: 200, height: 380 }) as DOMRect;
    mouse(row(TARGET_ID), "mousedown", 10, 310);
    mouse(document, "mousemove", 50, 420);
    expect(document.querySelector(".voice-drop-target")).toBeNull();
    mouse(document, "mouseup", 50, 420, 0);
    mouse(document, "click", 50, 420, 0);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("still drops after the sidebar re-renders mid-drag", () => {
    mount(true);
    mouse(row(TARGET_ID), "mousedown", 10, 310);
    mouse(document, "mousemove", 50, 360);
    joinVoice(4, 82, "Late");
    layOutDropAreas(container);
    mouse(document, "mousemove", 50, 420);
    mouse(document, "mouseup", 50, 420, 0);
    mouse(document, "click", 50, 420, 0);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(TARGET_ID, 4);
  });

  it("sends nothing when the user left during the drag", () => {
    mount(true);
    mouse(row(TARGET_ID), "mousedown", 10, 310);
    mouse(document, "mousemove", 50, 420);
    joinVoice(4, TARGET_ID, "Target");
    layOutDropAreas(container);
    mouse(document, "mouseup", 50, 520, 0);
    mouse(document, "click", 50, 520, 0);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("cancels on Escape", () => {
    mount(true);
    mouse(row(TARGET_ID), "mousedown", 10, 310);
    mouse(document, "mousemove", 50, 420);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    mouse(document, "mouseup", 10, 310, 0);
    mouse(row(TARGET_ID), "click", 10, 310, 0);
    expect(onMove).not.toHaveBeenCalled();
    // Releasing back over the row does not also open the profile.
    expect(mockOpenUserProfilePopup).not.toHaveBeenCalled();
    expect(document.querySelector(".voice-user-drag-ghost")).toBeNull();
  });

  it("stays cancelled after Escape until the button is released later", async () => {
    mount(true);
    mouse(row(TARGET_ID), "mousedown", 10, 310);
    mouse(document, "mousemove", 50, 420);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    mouse(document, "mousemove", 50, 420);
    expect(document.querySelector(".voice-user-drag-ghost")).toBeNull();
    expect(document.querySelector(".voice-drop-target")).toBeNull();
    mouse(document, "mouseup", 10, 310, 0);
    mouse(row(TARGET_ID), "click", 10, 310, 0);
    expect(onMove).not.toHaveBeenCalled();
    expect(mockOpenUserProfilePopup).not.toHaveBeenCalled();
  });

  it("keeps a plain click opening the profile", () => {
    mount(true);
    const r = row(TARGET_ID);
    mouse(r, "mousedown", 10, 310);
    mouse(r, "mouseup", 10, 310, 0);
    mouse(r, "click", 10, 310, 0);
    expect(onMove).not.toHaveBeenCalled();
    expect(mockOpenUserProfilePopup).toHaveBeenCalledTimes(1);
  });

  it("drops nothing when the socket went down mid-drag", () => {
    mount(true);
    mouse(row(TARGET_ID), "mousedown", 10, 310);
    mouse(document, "mousemove", 50, 420);
    uiStore.setState((prev) => ({ ...prev, connectionStatus: "reconnecting" as const }));
    mouse(document, "mouseup", 50, 420, 0);
    mouse(document, "click", 50, 420, 0);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("ends the drag when the sidebar is destroyed mid-drag", () => {
    mount(true);
    mouse(row(TARGET_ID), "mousedown", 10, 310);
    mouse(document, "mousemove", 50, 420);
    sidebar.destroy?.();
    expect(document.querySelector(".voice-user-drag-ghost")).toBeNull();
    expect(document.body.classList.contains("voice-user-moving")).toBe(false);
    mouse(document, "mouseup", 50, 420, 0);
    expect(onMove).not.toHaveBeenCalled();
  });
});
