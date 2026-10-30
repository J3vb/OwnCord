import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { attachChannelContextMenu } from "@components/channel-sidebar/contextMenu";
import { buildNotificationsTab } from "@components/settings/NotificationsTab";
import { invalidateMuteCache, muteChannel, setChannelMutesHost } from "@lib/prefs/channelMutes";
import {
  getChannelNotificationLevel,
  setChannelNotificationLevel,
  setGlobalNotificationLevel,
  setServerNotificationLevel,
} from "@lib/prefs/notificationLevel";
import { channelsStore } from "@stores/channels.store";
import { cascadedDeclaration } from "../helpers/app-css";
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
  setChannelMutesHost("ui.example");
  invalidateMuteCache();
  setGlobalNotificationLevel("mentions");
  container = document.createElement("div");
  document.body.appendChild(container);
  ac = new AbortController();
});

afterEach(() => {
  ac.abort();
  container.remove();
  document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());
  setChannelMutesHost(null);
  localStorage.clear();
});

function openMenu(ch: Channel): void {
  const el = document.createElement("div");
  container.appendChild(el);
  attachChannelContextMenu(el, ch, ac.signal, ac.signal);
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
}

const q = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);

describe("channel menu - notification settings", () => {
  it("submenu shows Use Server Default with the resolved level", () => {
    openMenu(channel());
    expect(q("ctx-notify-settings")!.textContent).toBe("Notification Settings");
    expect(q("ctx-notify-default")!.textContent).toBe("Use Server Default (Only @mentions)");
    expect(q("ctx-notify-all")!.textContent).toBe("All Messages");
    expect(q("ctx-notify-mentions")!.textContent).toBe("Only @mentions");
    expect(q("ctx-notify-nothing")!.textContent).toBe("Nothing");
  });

  it("resolves the default through a server override", () => {
    setServerNotificationLevel("nothing");
    openMenu(channel());
    expect(q("ctx-notify-default")!.textContent).toBe("Use Server Default (Nothing)");
  });

  it("rows are radios and only the current choice is checked", () => {
    setChannelNotificationLevel(5, "nothing");
    openMenu(channel());
    const checked = (id: string): string | null => q(id)!.getAttribute("aria-checked");
    expect(q("ctx-notify-nothing")!.getAttribute("role")).toBe("menuitemradio");
    expect(checked("ctx-notify-nothing")).toBe("true");
    expect(checked("ctx-notify-default")).toBe("false");
    expect(checked("ctx-notify-all")).toBe("false");
  });

  it("with no override the default row is the checked one", () => {
    openMenu(channel());
    expect(q("ctx-notify-default")!.getAttribute("aria-checked")).toBe("true");
  });

  it("choosing a level writes the override and closes the menu; Use Server Default clears it", () => {
    openMenu(channel());
    q("ctx-notify-nothing")!.click();
    expect(getChannelNotificationLevel(5)).toBe("nothing");
    expect(document.querySelector(".channel-ctx-menu")).toBeNull();

    openMenu(channel());
    q("ctx-notify-default")!.click();
    expect(getChannelNotificationLevel(5)).toBeNull();
  });

  it("clicking the trigger row itself changes nothing", () => {
    openMenu(channel());
    q("ctx-notify-settings")!.click();
    expect(getChannelNotificationLevel(5)).toBeNull();
    expect(document.querySelector(".channel-ctx-menu")).not.toBeNull();
  });

  it("is not offered for a voice channel", () => {
    openMenu(channel({ type: "voice" }));
    expect(q("ctx-notify-settings")).toBeNull();
  });
});

describe("Settings - channel notification overrides", () => {
  function mount(): HTMLElement {
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([[5, channel()]]),
    }));
    const tab = buildNotificationsTab(ac.signal);
    container.appendChild(tab);
    return tab;
  }

  it("is empty with no override", () => {
    mount();
    expect(q("channel-level-empty")).not.toBeNull();
  });

  it("lists an override with its level and Reset clears it", () => {
    setChannelNotificationLevel(5, "nothing");
    mount();
    expect(q("channel-level-5")!.textContent).toBe("Nothing");
    q("channel-level-reset-5")!.click();
    expect(getChannelNotificationLevel(5)).toBeNull();
    expect(q("channel-level-5")).toBeNull();
    expect(q("channel-level-empty")).not.toBeNull();
  });

  it("Reset hands focus to the next Reset button, then the list when none is left", async () => {
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([
        [5, channel()],
        [6, channel({ id: 6, name: "random" })],
      ]),
    }));
    setChannelNotificationLevel(5, "nothing");
    setChannelNotificationLevel(6, "all");
    container.appendChild(buildNotificationsTab(ac.signal));
    q("channel-level-reset-5")!.focus();
    q("channel-level-reset-5")!.click();
    await Promise.resolve();
    expect(document.activeElement).toBe(q("channel-level-reset-6"));
    q("channel-level-reset-6")!.click();
    await Promise.resolve();
    expect(document.activeElement).toBe(q("channel-level-list"));
  });

  it("names the channel on each Reset and Unmute button", () => {
    setChannelNotificationLevel(5, "nothing");
    muteChannel(5);
    mount();
    expect(q("channel-level-reset-5")!.getAttribute("aria-label")).toBe("Reset #general");
    expect(q("unmute-5")!.getAttribute("aria-label")).toBe("Unmute #general");
  });

  it("uses the same level wording as the channel menu", () => {
    setChannelNotificationLevel(5, "mentions");
    mount();
    expect(q("channel-level-5")!.textContent).toBe("Only @mentions");
    expect(q("notification-level-all")!.textContent).toBe("All Messages");
  });

  it("picks up an override set from a menu while the tab is open", () => {
    mount();
    setChannelNotificationLevel(5, "all");
    expect(q("channel-level-5")!.textContent).toBe("All Messages");
  });
});

describe("chosen level row", () => {
  it("shows a visible check mark, not only aria-checked", () => {
    const content = cascadedDeclaration(
      '.context-menu-item[role="menuitemradio"][aria-checked="true"]::after',
      "content",
    );
    expect(content).toBeDefined();
  });
});
