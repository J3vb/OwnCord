import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createUserProfilePopup } from "@components/UserProfilePopup";
import { createDmProfileSidebar } from "@components/DmProfileSidebar";
import { createDmSidebar, type DmConversation } from "@components/DmSidebar";
import { buildGameActivityRows } from "../../src/components/settings/GameActivityRows";
import { playingForLine, playingLine } from "../../src/features/members/gameActivityLine";
import {
  applyReadyCapabilities,
  resetServerCapabilities,
  serverSupportsGameActivity,
} from "@lib/serverCapabilities";
import { GAME_ACTIVITY_PREF_KEY, isGameActivityShared } from "@lib/gameActivityBridge";
import { loadPref } from "@lib/preferences";
import { buildDmConversations } from "../../src/pages/main-page/SidebarDmHelpers";
import { dmStore } from "../../src/stores/dm.store";

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);

describe("Playing lines", () => {
  it("says what is played, and for how long", () => {
    const game = { name: "VALORANT", startedAt: NOW - 23 * 60_000 };
    expect(playingLine(game)).toBe("Playing VALORANT");
    expect(playingForLine(game, NOW)).toBe("Playing VALORANT · for 23 min");
    expect(playingForLine({ ...game, startedAt: NOW - 30_000 }, NOW)).toBe(
      "Playing VALORANT · just started",
    );
    // A start time ahead of this clock is not a negative duration.
    expect(playingForLine({ ...game, startedAt: NOW + 60_000 }, NOW)).toBe(
      "Playing VALORANT · just started",
    );
    expect(playingForLine({ ...game, startedAt: NOW - 120 * 60_000 }, NOW)).toBe(
      "Playing VALORANT · for 2 h",
    );
    expect(playingForLine({ ...game, startedAt: NOW - 135 * 60_000 }, NOW)).toBe(
      "Playing VALORANT · for 2 h 15 min",
    );
  });
});

describe("game_activity capability", () => {
  afterEach(() => resetServerCapabilities());

  it("is false until a ready says so, and for a server that leaves it out", () => {
    expect(serverSupportsGameActivity()).toBe(false);
    applyReadyCapabilities({ read_pointer: true });
    expect(serverSupportsGameActivity()).toBe(false);
    applyReadyCapabilities({ game_activity: true });
    expect(serverSupportsGameActivity()).toBe(true);
    resetServerCapabilities();
    expect(serverSupportsGameActivity()).toBe(false);
  });
});

describe("profile card and DM profile sidebar", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
    vi.useRealTimers();
  });

  it("the popup shows Playing <game> · for N min, and nothing without a game", () => {
    const withGame = createUserProfilePopup({
      user: {
        id: 1,
        username: "alice",
        avatar: null,
        role: "member",
        status: "online",
        customStatus: "busy",
        activity: { name: "Factorio", startedAt: NOW - 5 * 60_000 },
      },
      anchorX: 1,
      anchorY: 1,
    });
    withGame.mount(container);
    expect(container.querySelector('[data-testid="upp-activity"]')?.textContent).toBe(
      "Playing Factorio · for 5 min",
    );
    // The custom status stays where it was; the game shows beside it here.
    expect(container.querySelector(".upp-custom-status")?.textContent).toBe("busy");
    withGame.destroy?.();

    const without = createUserProfilePopup({
      user: { id: 2, username: "bob", avatar: null, role: "member", status: "online" },
      anchorX: 1,
      anchorY: 1,
    });
    without.mount(container);
    expect(container.querySelector('[data-testid="upp-activity"]')?.textContent).toBe("");
    without.destroy?.();
  });

  it("the DM profile sidebar shows the game and follows update()", () => {
    const base = { id: 1, username: "Alice", avatar: null, status: "online" as const };
    const sidebar = createDmProfileSidebar({
      user: { ...base, activity: { name: "Factorio", startedAt: NOW - 90 * 60_000 } },
      onClose: vi.fn(),
    });
    sidebar.mount(container);
    expect(container.querySelector('[data-testid="dps-activity"]')?.textContent).toBe(
      "Playing Factorio · for 1 h 30 min",
    );
    sidebar.update({ ...base, activity: null });
    expect(container.querySelector('[data-testid="dps-activity"]')?.textContent).toBe("");
    sidebar.update({ ...base, activity: { name: "Satisfactory", startedAt: NOW } });
    expect(container.querySelector('[data-testid="dps-activity"]')?.textContent).toBe(
      "Playing Satisfactory · just started",
    );
    sidebar.destroy?.();
  });
});

describe("DM list rows", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
    dmStore.setState(() => ({ channels: [] }));
  });

  const convo = (overrides: Partial<DmConversation> = {}): DmConversation => ({
    channelId: 100,
    userId: 1,
    username: "Alice",
    avatar: null,
    status: "online",
    lastMessage: "Hello!",
    timestamp: "2025-01-01T00:00:00Z",
    unread: false,
    ...overrides,
  });

  it("draws the partner's game between the name and the last message, and updates in place", () => {
    const sidebar = createDmSidebar({
      conversations: [convo({ activity: "Playing Factorio" })],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);
    expect(container.querySelector('[data-testid="dm-activity-100"]')?.textContent).toBe(
      "Playing Factorio",
    );
    expect(container.querySelector(".dm-preview")?.textContent).toBe("Hello!");

    sidebar.update([convo()]);
    expect(container.querySelector('[data-testid="dm-activity-100"]')).toBeNull();
    sidebar.destroy?.();
  });

  it("never draws a game on a group row", () => {
    const sidebar = createDmSidebar({
      conversations: [convo({ isGroup: true, activity: "Playing Factorio" })],
      onSelectConversation: vi.fn(),
      onNewDm: vi.fn(),
    });
    sidebar.mount(container);
    expect(container.querySelector('[data-testid="dm-activity-100"]')).toBeNull();
    sidebar.destroy?.();
  });

  it("builds the row's line from the DM partner's copy, 1:1 only", () => {
    const partner = {
      id: 10,
      username: "bob",
      avatar: "",
      status: "online",
      activity: { name: "Factorio", startedAt: 1 },
    };
    const base = {
      participants: [partner],
      name: "",
      lastMessageId: null,
      lastMessage: "",
      lastMessageAt: "",
      unreadCount: 0,
      mentionCount: 0,
    };
    dmStore.setState(() => ({
      channels: [
        { ...base, channelId: 50, recipient: partner, isGroup: false },
        { ...base, channelId: 51, recipient: partner, isGroup: true },
      ],
    }));
    const rows = buildDmConversations(null);
    expect(rows.find((r) => r.channelId === 50)?.activity).toBe("Playing Factorio");
    expect(rows.find((r) => r.channelId === 51)?.activity).toBeUndefined();
  });
});

describe("Settings > Activity", () => {
  let signalOwner: AbortController;
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
    localStorage.clear();
    signalOwner = new AbortController();
  });
  afterEach(() => {
    signalOwner.abort();
    vi.useRealTimers();
  });

  function mountRows(): HTMLElement {
    const host = document.createElement("div");
    for (const el of buildGameActivityRows(signalOwner.signal)) host.appendChild(el);
    return host;
  }

  it("is on by default and shows what was detected", async () => {
    invoke.mockResolvedValue({ name: "Factorio", source: "steam", startedAtMs: 1 });
    const host = mountRows();
    const toggle = host.querySelector('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(isGameActivityShared()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('[data-testid="game-activity-detected"]')?.textContent).toBe(
      "Detected now: Factorio",
    );
  });

  it("says no game was detected, and treats a failing host that way", async () => {
    invoke.mockRejectedValue(new Error("no host"));
    const host = mountRows();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('[data-testid="game-activity-detected"]')?.textContent).toBe(
      "No game detected",
    );
  });

  it("turning it off saves the pref, scans no more, and hides the detected line", async () => {
    invoke.mockResolvedValue({ name: "Factorio", source: "steam", startedAtMs: 1 });
    const host = mountRows();
    await vi.advanceTimersByTimeAsync(0);
    const calls = invoke.mock.calls.length;

    (host.querySelector('[role="switch"]') as HTMLElement).click();
    expect(loadPref<boolean>(GAME_ACTIVITY_PREF_KEY, true)).toBe(false);
    const line = host.querySelector<HTMLElement>('[data-testid="game-activity-detected"]')!;
    expect(line.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(invoke.mock.calls.length).toBe(calls);

    // Back on: it looks again at once.
    (host.querySelector('[role="switch"]') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls.length).toBe(calls + 1);
    expect(line.hidden).toBe(false);
  });

  it("stops refreshing when the pane closes", async () => {
    invoke.mockResolvedValue(null);
    mountRows();
    await vi.advanceTimersByTimeAsync(0);
    signalOwner.abort();
    const calls = invoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(invoke.mock.calls.length).toBe(calls);
  });
});
