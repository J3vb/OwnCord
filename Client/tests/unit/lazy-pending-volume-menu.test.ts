/**
 * The per-user volume menu loads on its first open (O-6b): a second open in
 * the load window, a sidebar destroyed before the code arrives, and the
 * keyboard path landing focus inside the menu.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@lib/voice/livekitSession", () => ({
  setUserVolume: vi.fn(),
  getUserVolume: vi.fn(() => 1),
  getUserLocalMute: vi.fn(() => false),
  rePinPeerIdentity: vi.fn(() => Promise.resolve(true)),
}));

import { createChannelSidebar } from "../../src/components/ChannelSidebar";
import { channelsStore, setChannels } from "../../src/stores/channels.store";
import { authStore } from "../../src/stores/auth.store";
import { uiStore } from "../../src/stores/ui.store";
import { voiceStore, updateVoiceState } from "../../src/stores/voice.store";
import type { ReadyChannel } from "../../src/lib/types";

const SELF_ID = 99;
const TARGET_ID = 80;

describe("per-user volume menu during its load", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar> | null;

  function mount(): void {
    setChannels([
      { id: 3, name: "lobby", type: "voice", category: "Voice", position: 0 } as ReadyChannel,
    ]);
    updateVoiceState({
      channel_id: 3,
      user_id: TARGET_ID,
      username: "Target",
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
    });
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
    sidebar.mount(container);
  }

  const row = (): HTMLElement =>
    container.querySelector(`[data-voice-uid="${TARGET_ID}"]`) as HTMLElement;
  const menus = (): NodeListOf<Element> => document.querySelectorAll(".user-vol-menu");

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
      user: { id: SELF_ID, username: "Me", avatar: null, role: "member" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    sidebar?.destroy?.();
    sidebar = null;
    document.querySelectorAll(".user-vol-menu").forEach((el) => el.remove());
    container.remove();
  });

  it("two opens before the code arrives mount one menu, the second open's", async () => {
    mount();
    row().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    row().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 9, clientY: 9 }));
    expect(menus()).toHaveLength(0);
    await vi.dynamicImportSettled();
    expect(menus()).toHaveLength(1);
    const menu = menus()[0] as HTMLElement;
    expect(menu.style.left).toBe("9px");
    expect(menu.style.top).toBe("9px");
  });

  it("a sidebar destroyed before the code arrives mounts nothing", async () => {
    mount();
    row().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    sidebar!.destroy?.();
    await vi.dynamicImportSettled();
    expect(menus()).toHaveLength(0);
  });

  it("the keyboard path opens the menu and lands focus inside it", async () => {
    mount();
    row().focus();
    row().dispatchEvent(
      new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
    );
    await vi.dynamicImportSettled();
    const menu = document.querySelector(".user-vol-menu");
    expect(menu).not.toBeNull();
    expect(menu!.contains(document.activeElement)).toBe(true);
  });
});
