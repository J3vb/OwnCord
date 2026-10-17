import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemberColumn, type MemberColumn } from "../../src/pages/main-page/MemberColumn";
import type { MemberPanel } from "../../src/features/members/memberPanel";
import { channelsStore, type Channel } from "../../src/stores/channels.store";
import { uiStore } from "../../src/stores/ui.store";
import { savePref } from "../../src/lib/preferences";
import { MEMBER_LAYOUT_PREF, MEMBER_OPEN_PREF } from "../../src/features/members/memberLayout";

function channel(id: number, type: "text" | "voice" | "dm" | "announcement"): Channel {
  return {
    isPrivate: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
    id,
    name: `c${id}`,
    type,
    category: null,
    position: 0,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: null,
    canSend: true,
    topic: "",
    slowMode: 0,
    nsfw: false,
  };
}

function setActive(id: number | null): void {
  channelsStore.setState((prev) => ({
    ...prev,
    channels: new Map([
      [1, channel(1, "text")],
      [2, channel(2, "dm")],
      [3, channel(3, "announcement")],
    ]),
    activeChannelId: id,
  }));
  channelsStore.flush();
}

describe("MemberColumn", () => {
  let column: HTMLElement;
  let body: HTMLElement;
  let button: HTMLButtonElement;
  let buildPanel: ReturnType<typeof vi.fn<() => MemberPanel>>;
  let panels: Array<{ element: HTMLDivElement; destroy: ReturnType<typeof vi.fn> }>;
  let fallbackFocus: ReturnType<typeof vi.fn<() => HTMLElement | null>>;
  let ctrl: MemberColumn;

  function make(): MemberColumn {
    return createMemberColumn({ column, body, button, buildPanel, fallbackFocus });
  }

  beforeEach(() => {
    localStorage.clear();
    uiStore.setState((prev) => ({ ...prev, sidebarMode: "channels", activeView: null }));
    uiStore.flush();
    setActive(1);
    column = document.createElement("aside");
    column.hidden = true;
    body = document.createElement("div");
    column.appendChild(body);
    button = document.createElement("button");
    button.hidden = true;
    document.body.append(column, button);
    panels = [];
    buildPanel = vi.fn(() => {
      const element = document.createElement("div");
      element.dataset["testid"] = "member-list";
      const panel = { element, destroy: vi.fn() };
      panels.push(panel);
      return panel;
    });
    fallbackFocus = vi.fn(() => null);
    savePref(MEMBER_LAYOUT_PREF, "right");
  });

  afterEach(() => {
    ctrl?.destroy();
    column.remove();
    button.remove();
  });

  describe("shown only for right layout + guild channel + open + no content view", () => {
    const cases: Array<{
      name: string;
      arrange: () => void;
      shown: boolean;
      button: boolean;
    }> = [
      { name: "right layout, guild text channel", arrange: () => {}, shown: true, button: true },
      {
        name: "announcement channel",
        arrange: () => setActive(3),
        shown: true,
        button: true,
      },
      {
        name: "left layout",
        arrange: () => savePref(MEMBER_LAYOUT_PREF, "left"),
        shown: false,
        button: false,
      },
      {
        name: "stored open=false",
        arrange: () => savePref(MEMBER_OPEN_PREF, false),
        shown: false,
        button: true,
      },
      { name: "a DM", arrange: () => setActive(2), shown: false, button: false },
      {
        name: "DM sidebar mode",
        arrange: () => {
          uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));
          uiStore.flush();
        },
        shown: false,
        button: false,
      },
      {
        name: "a content view open",
        arrange: () => {
          uiStore.setState((prev) => ({ ...prev, activeView: "moderation" }));
          uiStore.flush();
        },
        shown: false,
        button: true,
      },
      { name: "no active channel", arrange: () => setActive(null), shown: false, button: false },
    ];
    for (const c of cases) {
      it(c.name, () => {
        c.arrange();
        ctrl = make();
        ctrl.sync();
        expect(column.hidden).toBe(!c.shown);
        expect(body.querySelectorAll('[data-testid="member-list"]').length).toBe(c.shown ? 1 : 0);
        expect(buildPanel).toHaveBeenCalledTimes(c.shown ? 1 : 0);
        expect(button.hidden).toBe(!c.button);
        expect(button.getAttribute("aria-pressed")).toBe(String(c.shown));
      });
    }
  });

  it("a repeated sync keeps the one panel", () => {
    ctrl = make();
    ctrl.sync();
    ctrl.sync();
    expect(buildPanel).toHaveBeenCalledTimes(1);
  });

  it("follows channel, mode and view changes through the stores", () => {
    ctrl = make();
    ctrl.sync();
    expect(column.hidden).toBe(false);

    setActive(2);
    expect(column.hidden).toBe(true);
    expect(panels[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(button.hidden).toBe(true);

    setActive(1);
    expect(column.hidden).toBe(false);
    expect(buildPanel).toHaveBeenCalledTimes(2);

    uiStore.setState((prev) => ({ ...prev, activeView: "moderation" }));
    uiStore.flush();
    expect(column.hidden).toBe(true);
    uiStore.setState((prev) => ({ ...prev, activeView: null }));
    uiStore.flush();
    expect(column.hidden).toBe(false);

    uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));
    uiStore.flush();
    expect(column.hidden).toBe(true);
  });

  it("toggle flips aria-pressed and saves memberListOpen; focus stays on the button", () => {
    ctrl = make();
    ctrl.sync();
    button.focus();
    expect(button.getAttribute("aria-pressed")).toBe("true");

    ctrl.toggle();
    expect(localStorage.getItem("owncord:settings:memberListOpen")).toBe("false");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(column.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(fallbackFocus).not.toHaveBeenCalled();

    ctrl.toggle();
    expect(localStorage.getItem("owncord:settings:memberListOpen")).toBe("true");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(column.hidden).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it("a memberListOpen change from elsewhere re-syncs", () => {
    ctrl = make();
    ctrl.sync();
    savePref(MEMBER_OPEN_PREF, false);
    expect(column.hidden).toBe(true);
  });

  it("ignores the layout key: MainPage's layout handler orders destroy before create", () => {
    ctrl = make();
    ctrl.sync();
    savePref(MEMBER_LAYOUT_PREF, "left");
    expect(column.hidden).toBe(false);
    expect(panels[0]!.destroy).not.toHaveBeenCalled();
    ctrl.sync();
    expect(column.hidden).toBe(true);
    expect(panels[0]!.destroy).toHaveBeenCalledTimes(1);
  });

  it("hiding destroys the panel and builds a new one on show", () => {
    ctrl = make();
    ctrl.sync();
    expect(buildPanel).toHaveBeenCalledTimes(1);

    ctrl.toggle();
    expect(panels[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(body.children.length).toBe(0);

    ctrl.toggle();
    expect(buildPanel).toHaveBeenCalledTimes(2);
    expect(body.children.length).toBe(1);
    expect(body.firstElementChild).toBe(panels[1]!.element);
  });

  it("focus inside the column at hide moves to fallbackFocus", () => {
    ctrl = make();
    ctrl.sync();
    const input = document.createElement("input");
    panels[0]!.element.appendChild(input);
    input.focus();
    expect(column.contains(document.activeElement)).toBe(true);

    ctrl.toggle();
    expect(fallbackFocus).toHaveBeenCalledTimes(1);
  });

  it("focus outside the column at hide leaves focus alone", () => {
    ctrl = make();
    ctrl.sync();
    button.focus();
    setActive(2);
    expect(fallbackFocus).not.toHaveBeenCalled();
  });

  it("destroy tears down the panel and the subscriptions", () => {
    ctrl = make();
    ctrl.sync();
    ctrl.destroy();
    expect(panels[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(body.children.length).toBe(0);

    setActive(2);
    setActive(1);
    savePref(MEMBER_OPEN_PREF, true);
    ctrl.sync();
    ctrl.toggle();
    expect(buildPanel).toHaveBeenCalledTimes(1);
  });
});
