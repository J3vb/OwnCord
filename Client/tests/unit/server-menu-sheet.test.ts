import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachServerMenu, type ServerMenuActions } from "../../src/pages/main-page/ServerMenu";
import { channelsStore, setChannels } from "../../src/stores/channels.store";
import { authStore } from "../../src/stores/auth.store";
import { isHideMutedChannels, setHideMutedChannels } from "@lib/prefs/hideMutedChannels";
import { closeBottomSheet } from "@lib/ui/bottomSheet";
import { Permission, type ReadyChannel } from "../../src/lib/types";

const CHANNELS: ReadyChannel[] = [
  {
    id: 1,
    name: "general",
    type: "text",
    category: "Text Channels",
    position: 0,
    unread_count: 3,
    mention_count: 0,
  },
];

const SHEET = '[data-testid="server-sheet"]';
const sheet = (): HTMLElement | null => document.querySelector<HTMLElement>(SHEET);
const row = (testId: string): HTMLElement =>
  sheet()!.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
const labels = (): string[] =>
  [...(sheet()?.querySelectorAll(".menu-sheet-label") ?? [])].map((el) => el.textContent ?? "");

async function settleHistory(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("server menu on a phone", () => {
  let button: HTMLButtonElement;
  let owner: AbortController;
  let actions: ServerMenuActions;
  let phone = true;

  const grant = (perms: number): void =>
    channelsStore.setState((prev) => ({
      ...prev,
      roles: [{ id: 5, name: "member", color: null, permissions: perms }],
    }));

  async function tap(): Promise<void> {
    button.click();
    if (phone) await vi.waitFor(() => expect(sheet()).not.toBeNull());
  }

  beforeEach(() => {
    phone = true;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({ matches: phone && q.includes("pointer: coarse") })),
    );
    localStorage.clear();
    authStore.setState(() => ({
      token: "tok",
      user: { id: 2, username: "Member", avatar: null, role: "member" },
      serverName: "Test Server",
      motd: null,
      isAuthenticated: true,
    }));
    setChannels(CHANNELS);
    grant(Permission.SEND_MESSAGES);
    actions = {
      onInvite: vi.fn(),
      onMarkRead: vi.fn(),
      onNotificationSettings: vi.fn(),
      onCreateChannel: vi.fn(),
      onCreateCategory: vi.fn(),
      onServerSettings: vi.fn(),
    };
    button = document.createElement("button");
    button.setAttribute("aria-haspopup", "menu");
    document.body.appendChild(button);
    owner = new AbortController();
    attachServerMenu(button, actions, owner.signal);
  });

  afterEach(async () => {
    closeBottomSheet();
    await settleHistory();
    owner.abort();
    button.remove();
    document.querySelectorAll(".server-menu").forEach((el) => el.remove());
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("opens the same rows as a sheet, not a popover, and tracks aria-expanded", async () => {
    await tap();
    expect(document.querySelector(".server-menu")).toBeNull();
    expect(sheet()!.getAttribute("aria-label")).toBe("Server actions");
    expect(labels()).toEqual(["Mark as Read", "Notification Settings", "Hide Muted Channels"]);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    closeBottomSheet();
    expect(sheet()).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await settleHistory();
  });

  it("keeps the popover menu off a phone", async () => {
    phone = false;
    await tap();
    expect(sheet()).toBeNull();
    expect(document.querySelector(".server-menu")).not.toBeNull();
  });

  it("closes first, then runs the action tapped", async () => {
    await tap();
    (actions.onNotificationSettings as ReturnType<typeof vi.fn>).mockImplementation(() => {
      expect(sheet()).toBeNull();
    });
    row("server-menu-notifications").click();
    expect(actions.onNotificationSettings).toHaveBeenCalledTimes(1);
  });

  it("shows Hide Muted Channels as a checkbox that follows the preference", async () => {
    setHideMutedChannels(true);
    await tap();
    const hide = row("server-menu-hide-muted");
    expect(hide.getAttribute("role")).toBe("checkbox");
    expect(hide.getAttribute("aria-checked")).toBe("true");
    hide.click();
    expect(isHideMutedChannels()).toBe(false);
  });

  it("adds the management rows, after a separation, for someone who may manage channels", async () => {
    grant(Permission.SEND_MESSAGES | Permission.MANAGE_CHANNELS);
    await tap();
    expect(labels()).toEqual(expect.arrayContaining(["Create Channel", "Create Category"]));
    expect(sheet()!.querySelectorAll(".msg-sheet-section").length).toBe(2);
    row("server-menu-create-channel").click();
    expect(actions.onCreateChannel).toHaveBeenCalledTimes(1);
  });
});
