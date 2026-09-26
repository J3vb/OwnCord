// B9-4: the content navigator, driven through inert test views. These prove
// the transitions later feature views rely on — open, close/Escape back to
// the channel the user came from, replacement, permission loss, sign-out and
// teardown — before any feature view exists.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { ApiClient } from "@lib/api";
import { Permission } from "@lib/types";
import { authStore, clearAuth } from "@stores/auth.store";
import { channelsStore, setActiveChannel, setRoles, type Channel } from "@stores/channels.store";
import { closeSettings, openSettings, setSidebarMode, uiStore } from "@stores/ui.store";
import { applyReadyActiveChannel } from "../channels/wsHandlers";
import type { Payload } from "../connection/dispatchContext";
import { createContentNavigator, trackCurrentView, type ContentNavigator } from "./contentView";
import type { FeatureViewContext, NavigationDestinations } from "./destinations";

const GENERAL = 1;
const RANDOM = 2;
const DM = 50;

interface InertView {
  readonly contexts: FeatureViewContext[];
  readonly build: (ctx: FeatureViewContext) => HTMLElement;
}

/** A view that renders one button and records every context it was given. */
function inertView(label: string): InertView {
  const contexts: FeatureViewContext[] = [];
  return {
    contexts,
    build: (ctx) => {
      contexts.push(ctx);
      const el = document.createElement("div");
      el.dataset["testid"] = `inert-${label}`;
      const btn = document.createElement("button");
      btn.textContent = `${label} action`;
      el.appendChild(btn);
      return el;
    },
  };
}

function signInAs(role: string, permissions: number): void {
  setRoles([{ id: 7, name: role, color: null, permissions }]);
  authStore.setState((prev) => ({
    ...prev,
    token: "tok",
    user: { id: 7, username: "mod", avatar: null, role },
    isAuthenticated: true,
  }));
}

function channel(id: number, name: string, type: "text" | "dm"): Channel {
  return {
    id,
    name,
    type,
    category: null,
    position: id,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: null,
    canSend: true,
    topic: "",
    slowMode: 0,
    nsfw: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
  };
}

function seedChannels(): void {
  channelsStore.setState((prev) => ({
    ...prev,
    channels: new Map([
      [GENERAL, channel(GENERAL, "general", "text")],
      [RANDOM, channel(RANDOM, "random", "text")],
      [DM, channel(DM, "alice", "dm")],
    ]),
    activeChannelId: GENERAL,
  }));
}

/** A text channel as a `ready` payload carries it. */
function readyTextChannel(id: number) {
  return { id, name: `c${id}`, type: "text", category: null, position: id };
}

/** Store notifications are batched on a microtask. */
function flush(): void {
  channelsStore.flush();
  uiStore.flush();
  authStore.flush();
}

let chatArea: HTMLDivElement;
let fallback: HTMLButtonElement;
let returnTarget: number | null;
let nav: ContentNavigator;
let requests: InertView;
let moderation: InertView;

/** The sidebar's channelBeforeDm path, reduced to what the navigator calls. */
function makeNavigator(destinations: NavigationDestinations): ContentNavigator {
  const created = createContentNavigator({
    destinations,
    api: {} as ApiClient,
    chatArea,
    rememberChannel: () => {
      const id = channelsStore.getState().activeChannelId;
      if (id !== null && id !== DM) returnTarget = id;
    },
    forgetChannel: () => {
      returnTarget = null;
    },
    returnToChannel: () => {
      setSidebarMode("channels");
      setActiveChannel(returnTarget);
      returnTarget = null;
    },
    fallbackFocus: () => fallback.focus(),
  });
  document.body.append(chatArea, created.element, fallback);
  return created;
}

function opener(): HTMLButtonElement {
  const btn = document.createElement("button");
  document.body.appendChild(btn);
  return btn;
}

beforeEach(() => {
  document.body.replaceChildren();
  chatArea = document.createElement("div");
  fallback = document.createElement("button");
  returnTarget = null;
  uiStore.setState((prev) => ({ ...prev, sidebarMode: "channels", activeView: null }));
  seedChannels();
  signInAs("Moderator", Permission.MODERATE_MEMBERS);
  requests = inertView("requests");
  moderation = inertView("moderation");
  nav = makeNavigator({
    requests: { build: requests.build, pending: { get: () => 0, subscribe: () => () => {} } },
    moderation: { build: moderation.build },
  });
  flush();
});

afterEach(() => {
  nav.destroy();
  closeSettings();
  vi.useRealTimers();
});

describe("opening a view", () => {
  it("replaces the chat column with a named region and moves focus to its heading", () => {
    const btn = opener();
    nav.open("moderation", btn);

    const region = nav.element;
    expect(region.getAttribute("role")).toBe("region");
    const title = region.querySelector("h2");
    expect(title?.textContent).toBe("Moderation");
    expect(region.getAttribute("aria-labelledby")).toBe(title?.id);
    expect(document.activeElement).toBe(title);
    expect(region.querySelector("[data-testid='inert-moderation']")).not.toBeNull();
    expect(region.style.display).toBe("");
    expect(chatArea.style.display).toBe("none");
    expect(uiStore.getState().activeView).toBe("moderation");
  });

  it("clears the active channel, so nothing counts as read behind the view", () => {
    nav.open("moderation", opener());
    expect(channelsStore.getState().activeChannelId).toBeNull();
    expect(returnTarget).toBe(GENERAL);
  });

  it("names the close control after the view", () => {
    nav.open("requests", opener());
    const close = nav.element.querySelector("[data-testid='feature-view-close']");
    expect(close?.getAttribute("aria-label")).toBe("Close Message Requests");
    expect(nav.element.querySelector("h2")?.textContent).toBe("Message Requests");
  });

  it("does nothing for a destination this build does not ship", () => {
    nav.destroy();
    nav = makeNavigator({});

    nav.open("requests", opener());

    expect(uiStore.getState().activeView).toBeNull();
    expect(nav.element.childElementCount).toBe(0);
    expect(channelsStore.getState().activeChannelId).toBe(GENERAL);
  });

  it("refuses Moderation without MODERATE_MEMBERS", () => {
    signInAs("Member", Permission.SEND_MESSAGES);

    nav.open("moderation", opener());

    expect(moderation.contexts).toHaveLength(0);
    expect(uiStore.getState().activeView).toBeNull();
  });

  it("re-opening the open view only refocuses it; it is not rebuilt", () => {
    nav.open("moderation", opener());
    (document.activeElement as HTMLElement).blur();

    nav.open("moderation", opener());

    expect(moderation.contexts).toHaveLength(1);
    expect(document.activeElement).toBe(nav.element.querySelector("h2"));
  });

  it("switching views destroys the old one and keeps the first opener", () => {
    vi.useFakeTimers();
    const first = opener();
    nav.open("moderation", first);
    nav.open("requests", opener());

    expect(moderation.contexts[0]?.signal.aborted).toBe(true);
    expect(nav.element.querySelector("[data-testid='inert-moderation']")).toBeNull();
    expect(nav.element.querySelector("[data-testid='inert-requests']")).not.toBeNull();

    nav.close();
    vi.runAllTimers();
    expect(document.activeElement).toBe(first);
  });

  it("a view that throws while building leaves nothing half-open", () => {
    nav.destroy();
    nav = makeNavigator({
      moderation: {
        build: () => {
          throw new Error("boom");
        },
      },
    });
    nav.open("moderation", opener());

    expect(uiStore.getState().activeView).toBeNull();
    expect(nav.element.childElementCount).toBe(0);
    expect(chatArea.style.display).toBe("");
    expect(channelsStore.getState().activeChannelId).toBe(GENERAL);
  });
});

describe("closing a view", () => {
  it("Close returns to the channel the user came from and focuses the opener", () => {
    vi.useFakeTimers();
    const btn = opener();
    nav.open("moderation", btn);
    nav.element.querySelector<HTMLButtonElement>("[data-testid='feature-view-close']")?.click();

    expect(moderation.contexts[0]?.signal.aborted).toBe(true);
    expect(nav.element.childElementCount).toBe(0);
    expect(nav.element.style.display).toBe("none");
    expect(chatArea.style.display).toBe("");
    expect(uiStore.getState().activeView).toBeNull();
    expect(channelsStore.getState().activeChannelId).toBe(GENERAL);
    vi.runAllTimers();
    expect(document.activeElement).toBe(btn);
  });

  it("Escape anywhere in the view closes it the same way", () => {
    vi.useFakeTimers();
    const btn = opener();
    nav.open("moderation", btn);
    const inner = nav.element.querySelector<HTMLButtonElement>(
      "[data-testid='inert-moderation'] button",
    );
    inner?.focus();
    inner?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(uiStore.getState().activeView).toBeNull();
    expect(channelsStore.getState().activeChannelId).toBe(GENERAL);
    vi.runAllTimers();
    expect(document.activeElement).toBe(btn);
  });

  it("an Escape the view handled itself does not close it", () => {
    nav.open("moderation", opener());
    const inner = nav.element.querySelector("[data-testid='inert-moderation']");
    inner?.addEventListener("keydown", (e) => e.preventDefault());
    inner?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    expect(uiStore.getState().activeView).toBe("moderation");
  });

  it("the view's own close() takes the same path", () => {
    nav.open("requests", opener());
    requests.contexts[0]?.close();
    expect(uiStore.getState().activeView).toBeNull();
    expect(channelsStore.getState().activeChannelId).toBe(GENERAL);
  });

  it("from DM mode, goes back to the channel before the DM, not the DM list", () => {
    returnTarget = RANDOM;
    setSidebarMode("dms");
    setActiveChannel(DM);
    flush();

    nav.open("requests", opener());
    expect(returnTarget).toBe(RANDOM);
    nav.close();

    expect(uiStore.getState().sidebarMode).toBe("channels");
    expect(channelsStore.getState().activeChannelId).toBe(RANDOM);
  });

  it("falls back to a reachable control once the channel remounts when the opener is gone", () => {
    vi.useFakeTimers();
    const btn = opener();
    nav.open("requests", btn);
    btn.remove();

    nav.close();
    expect(document.activeElement).not.toBe(fallback);
    vi.runAllTimers();

    expect(document.activeElement).toBe(fallback);
  });

  it("falls back when the opener sits in an inert subtree (the closed sidebar drawer)", () => {
    vi.useFakeTimers();
    const region = document.createElement("div");
    const btn = document.createElement("button");
    region.appendChild(btn);
    document.body.appendChild(region);
    nav.open("moderation", btn);
    region.setAttribute("inert", "");

    nav.close();
    vi.runAllTimers();

    expect(document.activeElement).toBe(fallback);
  });

  it("falls back when the opener is hidden", () => {
    vi.useFakeTimers();
    const btn = opener();
    nav.open("moderation", btn);
    btn.style.display = "none";

    nav.close();
    vi.runAllTimers();

    expect(document.activeElement).toBe(fallback);
  });

  it("a second close is a no-op", () => {
    nav.open("moderation", opener());
    nav.close();
    setActiveChannel(RANDOM);
    nav.close();
    expect(channelsStore.getState().activeChannelId).toBe(RANDOM);
  });
});

describe("leaving a view another way", () => {
  it("choosing a channel replaces the view without taking the back path", () => {
    nav.open("moderation", opener());
    setActiveChannel(RANDOM);
    flush();

    expect(moderation.contexts[0]?.signal.aborted).toBe(true);
    expect(uiStore.getState().activeView).toBeNull();
    expect(chatArea.style.display).toBe("");
    expect(channelsStore.getState().activeChannelId).toBe(RANDOM);
  });

  it("choosing a channel forgets the one the view would have gone back to", () => {
    nav.open("moderation", opener());
    expect(returnTarget).toBe(GENERAL);
    setActiveChannel(RANDOM);
    flush();
    expect(returnTarget).toBeNull();
  });

  it("choosing a DM keeps the channel to go back to", () => {
    nav.open("moderation", opener());
    setActiveChannel(DM);
    flush();
    expect(uiStore.getState().activeView).toBeNull();
    expect(returnTarget).toBe(GENERAL);
  });

  it("a fresh ready keeps an open view and the channel to go back to", () => {
    setActiveChannel(RANDOM);
    flush();
    nav.open("moderation", opener());
    flush();

    applyReadyActiveChannel({
      channels: [readyTextChannel(GENERAL), readyTextChannel(RANDOM)],
      dm_channels: [],
    } as unknown as Payload<"ready">);
    flush();

    expect(uiStore.getState().activeView).toBe("moderation");
    expect(moderation.contexts[0]?.signal.aborted).toBe(false);
    expect(channelsStore.getState().activeChannelId).toBeNull();
    nav.close();
    expect(channelsStore.getState().activeChannelId).toBe(RANDOM);
  });

  it("choosing the very channel the user came from also works", () => {
    nav.open("moderation", opener());
    // The click is a later task, after the view's own clear has notified.
    flush();
    setActiveChannel(GENERAL);
    flush();
    expect(uiStore.getState().activeView).toBeNull();
  });

  it("losing MODERATE_MEMBERS removes the Moderation view and its content at once", () => {
    vi.useFakeTimers();
    nav.open("moderation", opener());
    const content = nav.element.querySelector("[data-testid='inert-moderation']");

    setRoles([{ id: 7, name: "Moderator", color: null, permissions: Permission.SEND_MESSAGES }]);
    flush();

    expect(moderation.contexts[0]?.signal.aborted).toBe(true);
    expect(content?.isConnected).toBe(false);
    expect(uiStore.getState().activeView).toBeNull();
    expect(channelsStore.getState().activeChannelId).toBe(GENERAL);
    vi.runAllTimers();
    expect(document.body.contains(document.activeElement)).toBe(true);
  });

  it("a role change that keeps the permission leaves the view alone", () => {
    nav.open("moderation", opener());
    setRoles([{ id: 7, name: "Moderator", color: "#fff", permissions: Permission.ADMINISTRATOR }]);
    flush();
    expect(uiStore.getState().activeView).toBe("moderation");
  });

  it("permission loss does not touch a Requests view", () => {
    nav.open("requests", opener());
    signInAs("Member", Permission.SEND_MESSAGES);
    flush();
    expect(uiStore.getState().activeView).toBe("requests");
  });

  it("signing out clears the view before the page unmounts", () => {
    nav.open("moderation", opener());
    clearAuth();

    expect(moderation.contexts[0]?.signal.aborted).toBe(true);
    expect(nav.element.childElementCount).toBe(0);
    expect(uiStore.getState().activeView).toBeNull();
  });

  it("page teardown aborts the view and later opens do nothing", () => {
    nav.open("requests", opener());
    nav.destroy();

    expect(requests.contexts[0]?.signal.aborted).toBe(true);
    expect(uiStore.getState().activeView).toBeNull();
    nav.open("requests", opener());
    expect(requests.contexts).toHaveLength(1);
    // The view's own late close after teardown changes nothing.
    const before = channelsStore.getState().activeChannelId;
    returnTarget = RANDOM;
    requests.contexts[0]?.close();
    expect(channelsStore.getState().activeChannelId).toBe(before);
  });
});

describe("the entry's current-view state", () => {
  it("marks exactly the entry for the open view", () => {
    const entry = document.createElement("button");
    const unsub = trackCurrentView(entry, "requests");

    nav.open("requests", entry);
    flush();
    expect(entry.getAttribute("aria-current")).toBe("page");

    nav.open("moderation", entry);
    flush();
    expect(entry.hasAttribute("aria-current")).toBe(false);

    unsub();
  });
});

// Plan Task 4: channels → feature → DM → settings → logout, then a second
// session starts clean — with the pending work of each step disposed.
describe("a whole journey through inert views", () => {
  it("leaves no view, content or live signal behind at any step", () => {
    const btn = opener();

    // channels → feature
    nav.open("moderation", btn);
    const modSignal = moderation.contexts[0]!.signal;

    // feature → DM
    setSidebarMode("dms");
    setActiveChannel(DM);
    flush();
    expect(modSignal.aborted).toBe(true);
    expect(nav.element.childElementCount).toBe(0);
    expect(chatArea.style.display).toBe("");

    // DM → requests → settings on top: the view stays under the overlay
    nav.open("requests", btn);
    openSettings("Safety");
    flush();
    expect(uiStore.getState().activeView).toBe("requests");
    expect(uiStore.getState().settingsTab).toBe("Safety");
    closeSettings();
    expect(uiStore.getState().settingsTab).toBeNull();

    // settings → logout (profile switch takes the same clearAuth path)
    const reqSignal = requests.contexts[0]!.signal;
    clearAuth("server_switch");
    expect(reqSignal.aborted).toBe(true);
    expect(uiStore.getState().activeView).toBeNull();
    nav.destroy();

    // The next session's page starts with nothing open.
    seedChannels();
    signInAs("Moderator", Permission.MODERATE_MEMBERS);
    nav = makeNavigator({ moderation: { build: moderation.build } });
    expect(uiStore.getState().activeView).toBeNull();
    expect(nav.element.childElementCount).toBe(0);
  });
});
