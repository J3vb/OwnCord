import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachChannelContextMenu } from "@components/channel-sidebar/contextMenu";
import {
  getChannelMute,
  invalidateMuteCache,
  muteChannel,
  setChannelMutesHost,
} from "@lib/prefs/channelMutes";
import {
  getChannelNotificationLevel,
  setChannelNotificationLevel,
  setGlobalNotificationLevel,
} from "@lib/prefs/notificationLevel";
import { closeBottomSheet } from "@lib/ui/bottomSheet";
import { channelsStore, type Channel } from "@stores/channels.store";
import { makeChannel } from "../../helpers/channelFactory";

const channel = (overrides: Partial<Channel> = {}): Channel => makeChannel({ id: 5, ...overrides });

const SHEET = '[data-testid="channel-sheet"]';
const sheet = (): HTMLElement | null => document.querySelector<HTMLElement>(SHEET);
const row = (testId: string): HTMLElement | null =>
  sheet()?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null;
const labels = (): string[] =>
  [...(sheet()?.querySelectorAll<HTMLElement>(".menu-sheet-label") ?? [])].map(
    (el) => el.textContent ?? "",
  );
const back = (): HTMLElement | null =>
  sheet()?.querySelector("[data-testid='menu-sheet-back']") ?? null;

async function settleHistory(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("channel menu as a bottom sheet on a phone", () => {
  let container: HTMLDivElement;
  let owner: AbortController;
  let phone = true;

  /** A long-press arrives as a contextmenu event; the sheet's code loads on the first one. */
  async function longPress(
    ch: Channel,
    extra: Parameters<typeof attachChannelContextMenu> extends [
      unknown,
      unknown,
      unknown,
      unknown,
      ...infer R,
    ]
      ? R
      : never = [] as never,
  ): Promise<HTMLElement> {
    const el = document.createElement("div");
    container.appendChild(el);
    attachChannelContextMenu(el, ch, owner.signal, owner.signal, ...extra);
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
    if (phone) await vi.waitFor(() => expect(sheet()).not.toBeNull());
    return el;
  }

  beforeEach(() => {
    phone = true;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({ matches: phone && q.includes("pointer: coarse") })),
    );
    localStorage.clear();
    setChannelMutesHost("sheet.example");
    invalidateMuteCache();
    setGlobalNotificationLevel("mentions");
    container = document.createElement("div");
    document.body.appendChild(container);
    owner = new AbortController();
  });

  afterEach(async () => {
    closeBottomSheet();
    await settleHistory();
    owner.abort();
    container.remove();
    document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());
    setChannelMutesHost(null);
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("opens a sheet instead of the popover menu", async () => {
    await longPress(channel());
    expect(sheet()?.getAttribute("role")).toBe("dialog");
    expect(sheet()?.getAttribute("aria-label")).toBe("general options");
    expect(document.querySelector(".channel-ctx-menu")).toBeNull();
    expect(labels()).toEqual(
      expect.arrayContaining([
        "Mark as Read",
        "Mute Channel",
        "Notification Settings",
        "Copy Link",
      ]),
    );
  });

  it("keeps the popover menu off a phone", async () => {
    phone = false;
    await longPress(channel());
    expect(sheet()).toBeNull();
    expect(document.querySelector(".channel-ctx-menu")).not.toBeNull();
  });

  it("greys Mark as Read out when nothing is unread, and ignores a tap on it", async () => {
    await longPress(channel());
    const markRead = row("ctx-mark-read")!;
    expect(markRead.getAttribute("aria-disabled")).toBe("true");
    markRead.click();
    expect(sheet()).not.toBeNull();
  });

  describe("Mute Channel", () => {
    it("opens a second page with the durations and a back arrow, not a hover flyout", async () => {
      await longPress(channel());
      expect(back()).toBeNull();
      row("ctx-mute-channel")!.click();

      expect(back()).not.toBeNull();
      expect(back()!.getAttribute("aria-label")).toBe("Back");
      expect(sheet()!.querySelector(".menu-sheet-title")?.textContent).toBe("Mute Channel");
      expect(labels()).toEqual([
        "For 15 Minutes",
        "For 1 Hour",
        "For 3 Hours",
        "For 8 Hours",
        "For 24 Hours",
        "Until I turn it back on",
      ]);
      // Nothing was muted by opening the page.
      expect(getChannelMute(5)).toBeNull();
    });

    it("mutes for the duration tapped and closes the sheet", async () => {
      await longPress(channel());
      const before = Date.now();
      row("ctx-mute-channel")!.click();
      row("ctx-mute-for-3600000")!.click();
      expect(sheet()).toBeNull();
      const mute = getChannelMute(5);
      expect(mute?.until).toBeGreaterThanOrEqual(before + 3_600_000);
    });

    it("mutes until turned off from the last choice", async () => {
      await longPress(channel());
      row("ctx-mute-channel")!.click();
      row("ctx-mute-for-forever")!.click();
      expect(getChannelMute(5)).toEqual({ until: null });
    });

    it("returns to the first page with the back arrow, focus on the row it left", async () => {
      await longPress(channel());
      const mute = row("ctx-mute-channel")!;
      mute.click();
      back()!.click();
      expect(back()).toBeNull();
      expect(labels()).toContain("Mute Channel");
      expect(document.activeElement).toBe(row("ctx-mute-channel"));
      expect(getChannelMute(5)).toBeNull();
    });

    it("goes back a page on the first Escape and closes the sheet on the second", async () => {
      await longPress(channel());
      row("ctx-mute-channel")!.click();
      const first = sheet()!.querySelector<HTMLElement>(".menu-sheet-row")!;
      const escape = (): KeyboardEvent =>
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      first.dispatchEvent(escape());
      expect(sheet()).not.toBeNull();
      expect(back()).toBeNull();

      row("ctx-mute-channel")!.dispatchEvent(escape());
      expect(sheet()).toBeNull();
    });

    it("shows Unmute Channel with its end time, and a tap unmutes", async () => {
      muteChannel(5, 3_600_000);
      await longPress(channel());
      const unmute = row("ctx-mute-channel")!;
      expect(unmute.querySelector(".menu-sheet-label")?.textContent).toBe("Unmute Channel");
      expect(unmute.querySelector(".menu-sheet-detail")?.textContent).toMatch(/^Muted until /);
      expect(unmute.classList.contains("menu-sheet-next")).toBe(false);
      unmute.click();
      expect(sheet()).toBeNull();
      expect(getChannelMute(5)).toBeNull();
    });
  });

  describe("Notification Settings", () => {
    it("opens a radio page with the channel's level checked, and a tap sets the level", async () => {
      setChannelNotificationLevel(5, "all");
      await longPress(channel());
      row("ctx-notify-settings")!.click();

      expect(back()).not.toBeNull();
      const radios = [...sheet()!.querySelectorAll<HTMLElement>('[role="radio"]')];
      expect(radios.map((r) => r.querySelector(".menu-sheet-label")?.textContent)).toEqual([
        "Use Server Default (Only @mentions)",
        "All Messages",
        "Only @mentions",
        "Nothing",
      ]);
      expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual([
        "false",
        "true",
        "false",
        "false",
      ]);
      expect(sheet()!.querySelector('[role="radiogroup"]')).not.toBeNull();

      row("ctx-notify-nothing")!.click();
      expect(sheet()).toBeNull();
      expect(getChannelNotificationLevel(5)).toBe("nothing");
    });
  });

  describe("rows that need a permission", () => {
    const access = { manageChannels: true, manageMessages: true, manageInvites: true };
    // (el, channel, signal, lifetime, onEdit, onDelete, onPurge, channels, onReorder, onInvite, access)

    it("offers Edit and Delete (in red) to a channel manager, and Delete runs its callback after the sheet closes", async () => {
      const onEdit = vi.fn();
      const onDelete = vi.fn(() => {
        expect(sheet()).toBeNull();
      });
      const ch = channel();
      await longPress(ch, [onEdit, onDelete, undefined, undefined, undefined, undefined, access]);
      expect(row("ctx-edit-channel")).not.toBeNull();
      expect(row("ctx-delete-channel")!.classList.contains("danger")).toBe(true);
      row("ctx-delete-channel")!.click();
      expect(onDelete).toHaveBeenCalledWith(ch);
      expect(onEdit).not.toHaveBeenCalled();
    });

    it("offers none of them to a member", async () => {
      await longPress(channel(), [
        vi.fn(),
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        {
          manageChannels: false,
          manageMessages: false,
          manageInvites: false,
        },
      ]);
      expect(row("ctx-edit-channel")).toBeNull();
      expect(row("ctx-delete-channel")).toBeNull();
      expect(row("ctx-purge-messages")).toBeNull();
      expect(row("ctx-invite-people")).toBeNull();
    });

    it("runs Purge from its count prompt in the sheet, clamped to the server's range", async () => {
      const onPurge = vi.fn(() => Promise.resolve());
      const ch = channel();
      await longPress(ch, [vi.fn(), vi.fn(), onPurge, undefined, undefined, undefined, access]);
      const trigger = row("ctx-purge-messages")!;
      expect(trigger.getAttribute("role")).toBeNull();
      trigger.click();
      const input = sheet()!.querySelector<HTMLInputElement>('[data-testid="purge-count-input"]')!;
      input.value = "500";
      sheet()!.querySelector<HTMLElement>('[data-testid="purge-confirm"]')!.click();
      expect(onPurge).toHaveBeenCalledWith(ch, 100);
      await vi.waitFor(() => expect(sheet()).toBeNull());
    });

    it("moves a channel down from the sheet, and greys out Move Up at the top of its group", async () => {
      const a = channel({ id: 1, name: "a", position: 0 });
      const b = channel({ id: 2, name: "b", position: 1 });
      channelsStore.setState((prev) => ({
        ...prev,
        channels: new Map([
          [1, a],
          [2, b],
        ]),
      }));
      const onReorder = vi.fn();
      await longPress(a, [undefined, undefined, undefined, [a, b], onReorder, undefined, access]);
      expect(row("ctx-move-up")!.getAttribute("aria-disabled")).toBe("true");
      expect(row("ctx-move-down")!.getAttribute("aria-disabled")).toBeNull();

      row("ctx-move-down")!.click();
      expect(sheet()).toBeNull();
      expect(onReorder).toHaveBeenCalledWith([
        { channelId: 1, newPosition: 1, previousPosition: 0 },
        { channelId: 2, newPosition: 0, previousPosition: 1 },
      ]);
    });
  });
});
