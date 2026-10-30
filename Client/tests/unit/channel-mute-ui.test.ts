import { pruneExpiredMutes } from "@lib/prefs/channelMuteExpiry";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  attachChannelContextMenu,
  CHANNEL_MUTE_CHANGED,
} from "@components/channel-sidebar/context-menu";
import { buildNotificationsTab } from "@components/settings/NotificationsTab";
import {
  isChannelMuted,
  muteChannel,
  invalidateMuteCache,
  getChannelMute,
} from "@lib/prefs/channelMutes";
import { saveTimeFormat } from "@lib/text/timeFormat";
import { channelsStore } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import type { Channel } from "@stores/channels.store";

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 5,
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
    ...overrides,
  };
}

let container: HTMLDivElement;
let ac: AbortController;

beforeEach(() => {
  localStorage.clear();
  invalidateMuteCache();
  container = document.createElement("div");
  document.body.appendChild(container);
  ac = new AbortController();
});

afterEach(() => {
  ac.abort();
  container.remove();
  document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());
});

function openMenu(ch: Channel): HTMLElement {
  const el = document.createElement("div");
  container.appendChild(el);
  // Same signal for both the row-level listener and the menu's own lifetime
  // here — this suite doesn't exercise the render-vs-sidebar distinction
  // (see ChannelSidebar.test.ts's OC-0282 coverage for that), and `ac.abort()`
  // below still needs to close the menu.
  attachChannelContextMenu(el, ch, ac.signal, ac.signal);
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
  return el;
}

describe("channel context menu — mute", () => {
  it("offers Mute Channel for a text channel", () => {
    openMenu(channel());
    const item = document.querySelector('[data-testid="ctx-mute-channel"]');
    expect(item).not.toBeNull();
    expect(item!.textContent).toBe("Mute Channel");
  });

  it("says Unmute Channel when already muted", () => {
    muteChannel(5);
    openMenu(channel());
    expect(document.querySelector('[data-testid="ctx-mute-channel"]')!.textContent).toBe(
      "Unmute Channel",
    );
  });

  it("toggles the mute on click", () => {
    openMenu(channel());
    (document.querySelector('[data-testid="ctx-mute-channel"]') as HTMLElement).click();
    expect(isChannelMuted(5)).toBe(true);
  });

  it("fires a mute-changed event so the sidebar can redraw", () => {
    openMenu(channel());
    const seen: number[] = [];
    window.addEventListener(
      CHANNEL_MUTE_CHANGED,
      (e) => {
        seen.push((e as CustomEvent<{ channelId: number }>).detail.channelId);
      },
      { signal: ac.signal },
    );

    (document.querySelector('[data-testid="ctx-mute-channel"]') as HTMLElement).click();
    expect(seen).toEqual([5]);
  });

  it("keeps the menu inside the viewport when opened near the bottom edge (F9)", () => {
    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      value: 220,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      value: 260,
    });
    try {
      const el = document.createElement("div");
      container.appendChild(el);
      attachChannelContextMenu(el, channel(), ac.signal, ac.signal);
      el.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: innerWidth - 4,
          clientY: innerHeight - 4,
        }),
      );

      const menu = document.querySelector(".channel-ctx-menu") as HTMLElement;
      expect(parseInt(menu.style.left, 10)).toBeLessThanOrEqual(innerWidth - 220);
      expect(menu.style.bottom).not.toBe("");
    } finally {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)["offsetWidth"];
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)["offsetHeight"];
    }
  });

  // A voice channel produces no notifications, so a mute there would be an
  // affordance that cannot do anything.
  it("does not offer Mute for a voice channel", () => {
    openMenu(channel({ id: 6, type: "voice" }));
    expect(document.querySelector('[data-testid="ctx-mute-channel"]')).toBeNull();
  });

  it("offers Mute for a DM channel", () => {
    openMenu(channel({ id: 7, type: "dm" }));
    expect(document.querySelector('[data-testid="ctx-mute-channel"]')).not.toBeNull();
  });
});

describe("channel context menu — teardown", () => {
  // The menu is appended to document.body, not under the sidebar's own root,
  // so the sidebar's own AbortController tearing down must also remove it --
  // otherwise it survives as an undismissable orphan (e.g. onto the connect
  // page after logout).
  it("removes the open menu from document.body when the owning signal aborts", () => {
    openMenu(channel());
    expect(document.querySelector(".channel-ctx-menu")).not.toBeNull();

    ac.abort();

    expect(document.querySelector(".channel-ctx-menu")).toBeNull();
  });
});

describe("NotificationsTab — muted channel list", () => {
  it("says nothing is muted when nothing is", () => {
    const tab = buildNotificationsTab(ac.signal);
    container.appendChild(tab);
    expect(tab.querySelector('[data-testid="muted-empty"]')).not.toBeNull();
  });

  it("names a muted guild channel with a hash", () => {
    channelsStore.setState((prev) => {
      const next = new Map(prev.channels);
      next.set(5, channel({ id: 5, name: "general" }));
      return { ...prev, channels: next };
    });
    muteChannel(5);

    const tab = buildNotificationsTab(ac.signal);
    container.appendChild(tab);
    expect(tab.querySelector('[data-testid="muted-channel-list"]')!.textContent).toContain(
      "#general",
    );
  });

  it("names a muted DM with an at-sign and its display name", () => {
    dmStore.setState(() => ({
      channels: [
        {
          channelId: 9,
          recipient: { id: 2, username: "bob", avatar: "", status: "online" },
          participants: [{ id: 2, username: "bob", avatar: "", status: "online" }],
          name: "",
          isGroup: false,
          lastMessageId: null,
          lastMessage: "",
          lastMessageAt: "",
          unreadCount: 0,
          mentionCount: 0,
        },
      ],
    }));
    muteChannel(9);

    const tab = buildNotificationsTab(ac.signal);
    container.appendChild(tab);
    expect(tab.querySelector('[data-testid="muted-channel-list"]')!.textContent).toContain("@bob");
  });

  // A mute can outlive the channel it names (deleted channel, left group). It
  // is still listed, because otherwise there is no way to clear it.
  it("still lists a mute for a channel it cannot name", () => {
    channelsStore.setState((prev) => ({ ...prev, channels: new Map() }));
    dmStore.setState(() => ({ channels: [] }));
    muteChannel(4242);

    const tab = buildNotificationsTab(ac.signal);
    container.appendChild(tab);
    expect(tab.querySelector('[data-testid="muted-channel-list"]')!.textContent).toContain(
      "Channel 4242",
    );
  });

  it("unmutes from the list and removes the row", () => {
    muteChannel(5);
    const tab = buildNotificationsTab(ac.signal);
    container.appendChild(tab);

    (tab.querySelector('[data-testid="unmute-5"]') as HTMLElement).click();
    expect(isChannelMuted(5)).toBe(false);
    expect(tab.querySelector('[data-testid="unmute-5"]')).toBeNull();
    expect(tab.querySelector('[data-testid="muted-empty"]')).not.toBeNull();
  });

  it("announces a mute change on the window so any sidebar redraws (F16)", () => {
    // The Settings unmute used to update only its own row; a sidebar listening
    // for the mute-changed event stayed dimmed. The event now fires from the
    // channel-mutes store itself, so every writer reaches the sidebars.
    const seen: number[] = [];
    muteChannel(5);
    window.addEventListener(
      CHANNEL_MUTE_CHANGED,
      (e) => {
        seen.push((e as CustomEvent<{ channelId: number }>).detail.channelId);
      },
      { signal: ac.signal },
    );

    const tab = buildNotificationsTab(ac.signal);
    container.appendChild(tab);
    (tab.querySelector('[data-testid="unmute-5"]') as HTMLElement).click();

    expect(seen).toEqual([5]);
  });

  it("lists several mutes in ascending order", () => {
    muteChannel(9);
    muteChannel(2);
    const tab = buildNotificationsTab(ac.signal);
    container.appendChild(tab);

    const rows = [...tab.querySelectorAll(".settings-muted-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Channel 2");
    expect(rows[1]!.textContent).toContain("Channel 9");
  });
});

describe("channel context menu — timed mutes (3D-3a)", () => {
  const T0 = new Date(2026, 9, 17, 12, 0, 0).getTime();
  const HOUR = 3_600_000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    saveTimeFormat("12h");
  });
  afterEach(() => {
    vi.useRealTimers();
    saveTimeFormat("12h");
  });

  const trigger = (): HTMLElement =>
    document.querySelector('[data-testid="ctx-mute-channel"]') as HTMLElement;

  it("hover shows six duration rows", () => {
    openMenu(channel());
    const flyout = trigger().nextElementSibling as HTMLElement;
    expect(flyout.classList.contains("context-menu__submenu")).toBe(true);
    expect(flyout.style.display).toBe("none");

    trigger().dispatchEvent(new MouseEvent("mouseenter"));
    expect(flyout.style.display).toBe("");
    const rows = [...flyout.querySelectorAll('[role="menuitem"]')];
    expect(rows.map((r) => r.textContent)).toEqual([
      "For 15 Minutes",
      "For 1 Hour",
      "For 3 Hours",
      "For 8 Hours",
      "For 24 Hours",
      "Until I turn it back on",
    ]);

    trigger().dispatchEvent(new MouseEvent("mouseleave"));
    expect(flyout.style.display).toBe("none");
  });

  it("For 1 Hour mutes until now + 1 h and closes the menu", () => {
    openMenu(channel());
    trigger().dispatchEvent(new MouseEvent("mouseenter"));
    (document.querySelector('[data-testid="ctx-mute-for-3600000"]') as HTMLElement).click();
    expect(getChannelMute(5)).toEqual({ until: T0 + HOUR });
    expect(document.querySelector(".channel-ctx-menu")).toBeNull();
  });

  it("Until I turn it back on mutes with no end", () => {
    openMenu(channel());
    (document.querySelector('[data-testid="ctx-mute-for-forever"]') as HTMLElement).click();
    expect(getChannelMute(5)).toEqual({ until: null });
  });

  it("a click on the flyout does not also fire the trigger's mute-forever", () => {
    openMenu(channel());
    (document.querySelector('[data-testid="ctx-mute-for-900000"]') as HTMLElement).click();
    expect(getChannelMute(5)).toEqual({ until: T0 + 900_000 });
  });

  it("Enter on Mute Channel mutes until turned off", async () => {
    openMenu(channel());
    trigger().focus();
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(getChannelMute(5)).toEqual({ until: null });
  });

  it('muted row shows "Muted until" with the 12h format', () => {
    muteChannel(5, 900_000);
    openMenu(channel());
    expect(trigger().textContent).toBe("Unmute Channel" + "Muted until 12:15 PM");
    expect(trigger().querySelector(".context-menu-item__detail")!.textContent).toBe(
      "Muted until 12:15 PM",
    );
  });

  it('muted row shows "Muted until" with the 24h format', () => {
    saveTimeFormat("24h");
    muteChannel(5, 900_000);
    openMenu(channel());
    expect(trigger().querySelector(".context-menu-item__detail")!.textContent).toBe(
      "Muted until 12:15",
    );
  });

  it("adds the date when the mute ends on another day", () => {
    muteChannel(5, 86_400_000);
    openMenu(channel());
    expect(trigger().querySelector(".context-menu-item__detail")!.textContent).toBe(
      "Muted until October 18, 2026, 12:00 PM",
    );
  });

  it("a forever mute has no second line, and Unmute clears a timed mute", () => {
    muteChannel(5);
    openMenu(channel());
    expect(trigger().querySelector(".context-menu-item__detail")).toBeNull();
    document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());

    muteChannel(5, HOUR);
    openMenu(channel());
    trigger().click();
    expect(isChannelMuted(5)).toBe(false);
  });

  it("Unmute on a mute that has just expired is harmless", () => {
    muteChannel(5, 900_000);
    openMenu(channel());
    vi.setSystemTime(T0 + HOUR);
    expect(() => trigger().click()).not.toThrow();
    expect(isChannelMuted(5)).toBe(false);
  });
});

describe("NotificationsTab — timed mutes (3D-3a)", () => {
  const T0 = new Date(2026, 9, 17, 12, 0, 0).getTime();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    saveTimeFormat("12h");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Settings list shows until and drops the row on expiry", async () => {
    muteChannel(5, 900_000);
    muteChannel(6);
    const tab = buildNotificationsTab(ac.signal);
    container.appendChild(tab);
    expect(tab.querySelector('[data-testid="muted-until-5"]')!.textContent).toBe("Until 12:15 PM");
    expect(tab.querySelector('[data-testid="muted-until-6"]')).toBeNull();

    vi.setSystemTime(T0 + 900_000);
    pruneExpiredMutes(Date.now());
    await Promise.resolve();
    expect(tab.querySelector('[data-testid="unmute-5"]')).toBeNull();
    expect(tab.querySelector('[data-testid="unmute-6"]')).not.toBeNull();
  });

  it("hands focus to the next row's Unmute button when the focused one goes", async () => {
    muteChannel(5);
    muteChannel(6);
    muteChannel(7);
    const tab = buildNotificationsTab(ac.signal);
    container.appendChild(tab);
    const btn = (id: number): HTMLElement =>
      tab.querySelector(`[data-testid="unmute-${id}"]`) as HTMLElement;
    btn(6).focus();
    btn(6).click();
    await Promise.resolve();
    expect(document.activeElement).toBe(btn(7));

    btn(7).click();
    await Promise.resolve();
    expect(document.activeElement).toBe(btn(5));

    btn(5).click();
    await Promise.resolve();
    expect(document.activeElement).toBe(tab.querySelector('[data-testid="muted-channel-list"]'));
  });

  it("redraws once for a prune that ends several mutes", async () => {
    muteChannel(5, 900_000);
    muteChannel(6, 900_000);
    const tab = buildNotificationsTab(ac.signal);
    container.appendChild(tab);
    const list = tab.querySelector('[data-testid="muted-channel-list"]') as HTMLElement;
    const clears = vi.spyOn(list, "replaceChildren");
    const adds = vi.spyOn(list, "appendChild");
    vi.setSystemTime(T0 + 900_000);
    pruneExpiredMutes(Date.now());
    await Promise.resolve();
    // One empty-state node drawn, not one redraw per ended mute.
    expect(adds).toHaveBeenCalledTimes(1);
    expect(clears.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("stops listening once the tab's signal aborts", async () => {
    muteChannel(5, 900_000);
    const own = new AbortController();
    const tab = buildNotificationsTab(own.signal);
    container.appendChild(tab);
    own.abort();
    vi.setSystemTime(T0 + 900_000);
    pruneExpiredMutes(Date.now());
    await Promise.resolve();
    expect(tab.querySelector('[data-testid="unmute-5"]')).not.toBeNull();
  });
});
