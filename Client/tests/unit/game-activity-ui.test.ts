import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createUserProfilePopup } from "@components/UserProfilePopup";
import { createDmProfileSidebar } from "@components/DmProfileSidebar";
import { createDmSidebar, type DmConversation } from "@components/DmSidebar";
import { buildGameActivityRows } from "../../src/features/settings/GameActivityRows";
import { playingForLine, playingLine } from "../../src/features/members/gameActivityLine";
import {
  applyGameActivityPolicy,
  applyReadyCapabilities,
  resetServerCapabilities,
  serverSupportsGameActivity,
} from "@lib/net/serverCapabilities";
import { GAME_ACTIVITY_PREF_KEY, isGameActivityShared } from "@lib/presence/gameActivityBridge";
import { loadPref } from "@lib/prefs/preferences";
import {
  EMPTY_GAME_PREFS,
  loadGamePrefs,
  recordSeen,
  saveGamePrefs,
  withHidden,
  withManual,
  withRename,
} from "@lib/prefs/gameActivityPrefs";
import { desktop } from "../../src/platform/desktop";
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

describe("Playing line duration boundaries", () => {
  const game = { name: "VALORANT", startedAt: 0 };

  it("switches from just started to minutes at exactly one minute", () => {
    expect(playingForLine(game, 59_999)).toBe("Playing VALORANT · just started");
    expect(playingForLine(game, 60_000)).toBe("Playing VALORANT · for 1 min");
  });

  it("switches from minutes to hours at exactly sixty minutes", () => {
    expect(playingForLine(game, 59 * 60_000)).toBe("Playing VALORANT · for 59 min");
    expect(playingForLine(game, 60 * 60_000)).toBe("Playing VALORANT · for 1 h");
    expect(playingForLine(game, 61 * 60_000)).toBe("Playing VALORANT · for 1 h 1 min");
  });

  it("falls back to just started for a clock that is not a number", () => {
    expect(playingForLine(game, Number.NaN)).toBe("Playing VALORANT · just started");
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

  it("says game activity is turned off on this server while the switch is off, and hides it again when on", async () => {
    invoke.mockResolvedValue({ name: "Factorio", source: "steam", startedAtMs: 1 });
    applyReadyCapabilities({ game_activity: true });
    const host = mountRows();
    const note = host.querySelector<HTMLElement>('[data-testid="game-activity-server-off"]')!;
    await vi.advanceTimersByTimeAsync(0);
    expect(note.hidden).toBe(true);

    applyGameActivityPolicy(false);
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe("Game activity is turned off on this server.");

    applyGameActivityPolicy(true);
    expect(note.hidden).toBe(true);
    resetServerCapabilities();
  });

  it("shows the note when a ready advertised the capability off", async () => {
    applyReadyCapabilities({ game_activity: false });
    const host = mountRows();
    expect(
      host.querySelector<HTMLElement>('[data-testid="game-activity-server-off"]')?.hidden,
    ).toBe(false);
    resetServerCapabilities();
  });

  it("shows no note before a ready has arrived", () => {
    const host = mountRows();
    expect(
      host.querySelector<HTMLElement>('[data-testid="game-activity-server-off"]')?.hidden,
    ).toBe(true);
  });

  it("shows the detected game under the name others see", async () => {
    saveGamePrefs(withRename(EMPTY_GAME_PREFS, "Factorio", "My Factory"));
    invoke.mockResolvedValue({ name: "Factorio", source: "steam", startedAtMs: 1 });
    const host = mountRows();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('[data-testid="game-activity-detected"]')?.textContent).toBe(
      "Detected now: My Factory",
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

describe("Settings > Activity > Your games", () => {
  let signalOwner: AbortController;
  const programs = [
    { name: "factorio", path: "/g/factorio/bin/factorio" },
    { name: "Hades", path: "C:\\Games\\Hades\\Hades.exe" },
    { name: "firefox", path: "/usr/lib/firefox/firefox" },
  ];

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "list_running_programs" ? programs : null,
    );
    localStorage.clear();
    signalOwner = new AbortController();
  });
  afterEach(() => {
    signalOwner.abort();
  });

  function mount(): HTMLElement {
    const host = document.createElement("div");
    for (const el of buildGameActivityRows(signalOwner.signal)) host.appendChild(el);
    document.body.appendChild(host);
    return host;
  }
  const q = <T extends HTMLElement>(host: HTMLElement, id: string): T =>
    host.querySelector<T>(`[data-testid="${id}"]`)!;
  const all = (host: HTMLElement, id: string): HTMLElement[] =>
    Array.from(host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
  const names = (host: HTMLElement): string[] =>
    all(host, "game-row-name").map((n) => n.textContent ?? "");
  const tick = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  function type(input: HTMLInputElement, text: string): void {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function key(input: HTMLElement, k: string): KeyboardEvent {
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    input.dispatchEvent(e);
    return e;
  }

  it("says so when no game has been seen or added", () => {
    const host = mount();
    expect(q(host, "game-activity-games-empty").textContent).toContain("No games yet");
    host.remove();
  });

  it("lists every seen and every added game, each with its shown name", () => {
    recordSeen("Factorio");
    recordSeen("Hades");
    saveGamePrefs(
      withRename(withManual(EMPTY_GAME_PREFS, "/x/mine", "Mine")!, "Hades", "Hades II"),
    );
    const host = mount();
    // Added games first, then detected ones, newest first.
    expect(names(host)).toEqual(["Mine", "Hades II", "Factorio"]);
    expect(all(host, "game-row-note").map((n) => n.textContent)).toEqual([
      "Added by you",
      "Detected as Hades",
    ]);
    // Only the added one can be removed.
    expect(all(host, "game-remove")).toHaveLength(1);
    host.remove();
  });

  it("renames inline: Enter saves, Esc cancels, blank resets to the detected name", () => {
    recordSeen("Factorio");
    const host = mount();

    q(host, "game-rename").click();
    let input = q<HTMLInputElement>(host, "game-rename-input");
    expect(input.value).toBe("Factorio");
    type(input, "My Factory");
    expect(key(input, "Enter").defaultPrevented).toBe(true);
    expect(loadGamePrefs().renames).toEqual({ Factorio: "My Factory" });
    expect(names(host)).toEqual(["My Factory"]);

    q(host, "game-rename").click();
    input = q<HTMLInputElement>(host, "game-rename-input");
    expect(input.value).toBe("My Factory");
    type(input, "Discarded");
    // Esc ends the edit and does not reach the settings overlay's own handler.
    const outer = vi.fn();
    document.addEventListener("keydown", outer, { once: true });
    key(input, "Escape");
    document.removeEventListener("keydown", outer);
    expect(outer).not.toHaveBeenCalled();
    expect(loadGamePrefs().renames).toEqual({ Factorio: "My Factory" });
    expect(host.querySelector('[data-testid="game-rename-input"]')).toBeNull();

    q(host, "game-rename").click();
    input = q<HTMLInputElement>(host, "game-rename-input");
    type(input, "   ");
    key(input, "Enter");
    expect(loadGamePrefs().renames).toEqual({});
    expect(names(host)).toEqual(["Factorio"]);
    host.remove();
  });

  it("does not redraw under an open rename when a game is detected meanwhile", () => {
    recordSeen("Factorio");
    const host = mount();
    q(host, "game-rename").click();
    const input = q<HTMLInputElement>(host, "game-rename-input");
    type(input, "Half typed");
    recordSeen("Hades");
    q(host, "game-activity-games").dispatchEvent(new Event("pointerenter"));
    expect(q<HTMLInputElement>(host, "game-rename-input")).toBe(input);
    expect(input.value).toBe("Half typed");
    key(input, "Escape");
    q(host, "game-activity-games").dispatchEvent(new Event("pointerenter"));
    expect(names(host)).toEqual(["Hades", "Factorio"]);
    host.remove();
  });

  it("the Show to others switch hides and shows a game", () => {
    recordSeen("Factorio");
    const host = mount();
    const toggle = host.querySelector<HTMLElement>('[data-testid="game-row"] [role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Show Factorio to others");
    toggle.click();
    expect(loadGamePrefs().hidden).toEqual(["Factorio"]);
    toggle.click();
    expect(loadGamePrefs().hidden).toEqual([]);
    host.remove();
  });

  it("a hidden game stays listed, switched off, so it can be shown again", () => {
    saveGamePrefs(withHidden(EMPTY_GAME_PREFS, "Old Game", true));
    const host = mount();
    expect(names(host)).toEqual(["Old Game"]);
    const toggle = host.querySelector<HTMLElement>('[data-testid="game-row"] [role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    host.remove();
  });

  it("the picker lists running programs, filters them, and adds the one picked under its edited name", async () => {
    const host = mount();
    expect(q(host, "game-picker").hidden).toBe(true);
    q(host, "game-add").click();
    await tick();
    expect(invoke).toHaveBeenCalledWith("list_running_programs");
    expect(all(host, "game-picker-item").map((i) => i.firstElementChild?.textContent)).toEqual([
      "factorio",
      "Hades",
      "firefox",
    ]);

    const filter = q<HTMLInputElement>(host, "game-picker-filter");
    type(filter, "FA");
    expect(all(host, "game-picker-item").map((i) => i.firstElementChild?.textContent)).toEqual([
      "factorio",
    ]);
    type(filter, "zzz");
    expect(all(host, "game-picker-item")).toHaveLength(0);
    expect(q(host, "game-picker-list").textContent).toContain("No program matches");
    type(filter, "hades");
    all(host, "game-picker-item")[0]!.click();

    const name = q<HTMLInputElement>(host, "game-picker-name");
    expect(name.value).toBe("Hades");
    type(name, "  Hades (mine) ");
    q(host, "game-picker-save").click();

    expect(loadGamePrefs().manual).toEqual([
      { path: "C:\\Games\\Hades\\Hades.exe", name: "Hades (mine)" },
    ]);
    expect(q(host, "game-picker").hidden).toBe(true);
    expect(names(host)).toEqual(["Hades (mine)"]);
    // Nothing in the list reached the server or storage: only the choice did.
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain("firefox");
    host.remove();
  });

  it("an Enter that commits an IME candidate saves neither a rename nor an added name", async () => {
    recordSeen("Factorio");
    const host = mount();
    q(host, "game-rename").click();
    const rename = q<HTMLInputElement>(host, "game-rename-input");
    type(rename, "Half");
    rename.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(loadGamePrefs().renames).toEqual({});
    expect(q<HTMLInputElement>(host, "game-rename-input")).toBe(rename);
    key(rename, "Escape");

    q(host, "game-add").click();
    await tick();
    all(host, "game-picker-item")[0]!.click();
    const name = q<HTMLInputElement>(host, "game-picker-name");
    type(name, "Half");
    name.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(loadGamePrefs().manual).toEqual([]);
    expect(q(host, "game-picker").hidden).toBe(false);
    host.remove();
  });

  it("Enter in the name step saves, a blank name is refused, and Esc closes the picker", async () => {
    const host = mount();
    q(host, "game-add").click();
    await tick();
    all(host, "game-picker-item")[0]!.click();
    const name = q<HTMLInputElement>(host, "game-picker-name");
    type(name, "   ");
    key(name, "Enter");
    expect(q(host, "game-picker-error").hidden).toBe(false);
    expect(loadGamePrefs().manual).toEqual([]);
    type(name, "Factory");
    key(name, "Enter");
    expect(loadGamePrefs().manual).toEqual([{ path: "/g/factorio/bin/factorio", name: "Factory" }]);

    q(host, "game-add").click();
    await tick();
    // The program just added is no longer offered.
    expect(all(host, "game-picker-item").map((i) => i.firstElementChild?.textContent)).toEqual([
      "Hades",
      "firefox",
    ]);
    key(q(host, "game-picker-filter"), "Escape");
    expect(q(host, "game-picker").hidden).toBe(true);
    host.remove();
  });

  it("shows a plain empty state when no programs are found, or the host fails", async () => {
    for (const impl of [
      async () => [],
      async (): Promise<never> => {
        throw new Error("no host");
      },
    ]) {
      invoke.mockImplementation(impl);
      const host = mount();
      q(host, "game-add").click();
      await tick();
      expect(q(host, "game-picker-empty").textContent).toContain("No programs found");
      expect(all(host, "game-picker-item")).toHaveLength(0);
      q(host, "game-picker-cancel").click();
      expect(q(host, "game-picker").hidden).toBe(true);
      host.remove();
    }
  });

  it("a list that answers after the picker was closed does not reopen it", async () => {
    let answer: (v: unknown) => void = () => {};
    invoke.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const host = mount();
    q(host, "game-add").click();
    q(host, "game-add").click();
    answer(programs);
    await tick();
    expect(q(host, "game-picker").hidden).toBe(true);
    expect(all(host, "game-picker-item")).toHaveLength(0);
    host.remove();
  });

  it("removes an added game with its rename and hide", () => {
    saveGamePrefs(
      withHidden(
        withRename(withManual(EMPTY_GAME_PREFS, "/x/mine", "Mine")!, "Mine", "M"),
        "Mine",
        true,
      ),
    );
    const host = mount();
    expect(names(host)).toEqual(["M"]);
    q(host, "game-remove").click();
    expect(loadGamePrefs()).toEqual(EMPTY_GAME_PREFS);
    expect(names(host)).toEqual([]);
    expect(q(host, "game-activity-games-empty")).not.toBeNull();
    host.remove();
  });

  it("moving focus through the list does not redraw it, and a pointer visit redraws only on a change", () => {
    recordSeen("Factorio");
    recordSeen("Hades");
    const host = mount();
    const list = q(host, "game-activity-games");
    const buttons = list.querySelectorAll<HTMLElement>("button, [role='switch']");
    const first = list.querySelector<HTMLElement>('[data-testid="game-row"]')!;
    for (const el of buttons) {
      el.focus();
      el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      expect(document.activeElement).toBe(el);
      expect(el.isConnected).toBe(true);
    }
    // A visit with nothing new keeps the very same elements (and focus).
    const toggle = list.querySelector<HTMLElement>("[role='switch']")!;
    toggle.focus();
    list.dispatchEvent(new Event("pointerenter"));
    expect(document.activeElement).toBe(toggle);
    expect(list.querySelector('[data-testid="game-row"]')).toBe(first);
    // Something new was detected: now it redraws.
    recordSeen("Celeste");
    list.dispatchEvent(new Event("pointerenter"));
    expect(names(host)).toEqual(["Celeste", "Hades", "Factorio"]);
    host.remove();
  });

  it("puts focus back on the rename button after Enter or Esc in a rename", () => {
    recordSeen("Factorio");
    const host = mount();
    q(host, "game-rename").click();
    type(q<HTMLInputElement>(host, "game-rename-input"), "Factory");
    key(q(host, "game-rename-input"), "Enter");
    expect(document.activeElement).toBe(q(host, "game-rename"));
    q(host, "game-rename").click();
    key(q(host, "game-rename-input"), "Escape");
    expect(document.activeElement).toBe(q(host, "game-rename"));
    host.remove();
  });

  it("puts focus on Add a game after the picker closes, saves, or an entry is removed", async () => {
    const host = mount();
    const add = q(host, "game-add");
    add.click();
    await tick();
    q(host, "game-picker-cancel").click();
    expect(document.activeElement).toBe(add);

    add.click();
    await tick();
    all(host, "game-picker-item")[0]!.click();
    q(host, "game-picker-save").click();
    expect(document.activeElement).toBe(add);

    q(host, "game-rename").focus();
    q(host, "game-remove").click();
    expect(document.activeElement).toBe(add);
    host.remove();
  });

  it("a removed added game that had run leaves no row behind", () => {
    // A manual game is never recorded as detected, so removing it removes its row.
    saveGamePrefs(withHidden(withManual(EMPTY_GAME_PREFS, "/x/mine", "Mine")!, "Mine", true));
    const host = mount();
    q(host, "game-remove").click();
    expect(loadGamePrefs()).toEqual(EMPTY_GAME_PREFS);
    expect(names(host)).toEqual([]);
    host.remove();
  });

  it("is not drawn on the web build", () => {
    const original = desktop.gameDetector.available;
    Object.defineProperty(desktop.gameDetector, "available", { value: false, configurable: true });
    try {
      const host = mount();
      expect(host.children).toHaveLength(0);
      expect(host.querySelector('[data-testid="game-add"]')).toBeNull();
      expect(host.querySelector('[data-testid="game-activity-games"]')).toBeNull();
      host.remove();
    } finally {
      Object.defineProperty(desktop.gameDetector, "available", {
        value: original,
        configurable: true,
      });
    }
  });
});
