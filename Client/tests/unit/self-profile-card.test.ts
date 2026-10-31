import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { authStore } from "@stores/auth.store";
import { membersStore } from "@stores/members.store";
import { uiStore, setConnectionStatus } from "@stores/ui.store";
import { createUserBar } from "@components/UserBar";
import {
  loadCustomStatus,
  loadStatusTimer,
  loadUserStatus,
  saveStatusTimer,
  saveUserStatus,
} from "@lib/presence/userStatus";
import { loadEmojiCatalog } from "../../src/features/messaging/emojiCatalog";
import { savePref } from "@lib/prefs/preferences";
import { createPresenceSender } from "@lib/presence/presence";
import { createPresenceLimiter } from "@lib/net/rateLimiter";
import type { WsClient } from "@lib/ws";
import { clearHost, hostAndroidApp } from "../helpers/androidHost";
import { resetAuthState } from "../helpers/storeSeeds";

function setUser(custom: string | null = null): void {
  authStore.setState(() => ({
    token: "tok",
    user: {
      id: 7,
      username: "alice",
      display_name: "Alice A",
      avatar: null,
      role: "member",
      custom_status: custom,
    },
    serverName: "TestServer",
    motd: null,
    isAuthenticated: true,
  }));
}

function mockWs(): WsClient {
  return {
    send: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
    onStateChange: vi.fn().mockReturnValue(() => {}),
    getState: vi.fn(() => "connected"),
  } as unknown as WsClient;
}

const q = <T extends HTMLElement>(sel: string): T | null => document.body.querySelector<T>(sel);
const card = (): HTMLElement | null => q("[data-testid='self-profile-card']");
const trigger = (): HTMLButtonElement => q<HTMLButtonElement>("[data-testid='user-bar-profile']")!;

describe("SelfProfileCard from the user bar", () => {
  let container: HTMLDivElement;
  let comp: ReturnType<typeof createUserBar>;
  let ws: WsClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    setConnectionStatus("connected");
    setUser();
    // Our own member entry, as the ready/member_list payload leaves it.
    membersStore.setState((p) => ({
      ...p,
      members: new Map([[7, { id: 7, username: "alice", status: "online" } as never]]),
    }));
    membersStore.flush();
    ws = mockWs();
    comp = createUserBar({ ws, presenceSender: createPresenceSender(ws, createPresenceLimiter()) });
    comp.mount(container);
  });

  afterEach(() => {
    comp.destroy?.();
    container.remove();
    membersStore.setState((p) => ({ ...p, members: new Map() }));
    setConnectionStatus("disconnected");
    resetAuthState();
    uiStore.setState((p) => ({ ...p, settingsOpen: false, settingsTab: null }));
  });

  it("the avatar and name are one real button that opens the card", () => {
    const btn = trigger();
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("aria-haspopup")).toBe("dialog");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.querySelector(".ub-avatar")).not.toBeNull();
    expect(btn.querySelector(".ub-name")).not.toBeNull();
    expect(card()).toBeNull();

    btn.click();
    expect(card()).not.toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(q("[data-testid='spc-name']")?.textContent).toBe("Alice A");
    expect(q("[data-testid='spc-username']")?.textContent).toBe("alice");

    btn.click();
    expect(card()).toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("marks the current status and shows the notes under DnD and Invisible", () => {
    saveUserStatus("idle");
    trigger().click();
    expect(q("[data-testid='spc-status-idle']")?.getAttribute("aria-checked")).toBe("true");
    expect(q("[data-testid='spc-status-online']")?.getAttribute("aria-checked")).toBe("false");
    expect(q("[data-testid='spc-note-dnd']")?.textContent).toBe(
      "You will not receive desktop notifications",
    );
    expect(q("[data-testid='spc-note-invisible']")?.textContent).toBe("You will appear offline");
    expect(q("[data-testid='spc-note-online']")).toBeNull();
  });

  it('words the Do Not Disturb note without "desktop" in the Android app', () => {
    hostAndroidApp();
    try {
      trigger().click();
      expect(q("[data-testid='spc-note-dnd']")?.textContent).toBe(
        "You will not receive notifications",
      );
      expect(q("[data-testid='spc-note-invisible']")?.textContent).toBe("You will appear offline");
    } finally {
      clearHost();
    }
  });

  it("choosing a status saves and sends it, closes the card and refocuses the button", () => {
    trigger().click();
    q<HTMLButtonElement>("[data-testid='spc-status-dnd']")!.click();
    expect(loadUserStatus()).toBe("dnd");
    expect(ws.send).toHaveBeenCalledOnce();
    const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.payload.status).toBe("dnd");
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("Enter that commits an IME candidate neither commits nor closes", () => {
    trigger().click();
    const input = q<HTMLInputElement>("[data-testid='spc-custom-input']")!;
    input.value = "half";
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(ws.send).not.toHaveBeenCalled();
    expect(card()).not.toBeNull();
    expect(input.value).toBe("half");
  });

  it("the custom status can be set (trimmed, capped at 128) and cleared", () => {
    trigger().click();
    const input = q<HTMLInputElement>("[data-testid='spc-custom-input']")!;
    expect(input.maxLength).toBe(256); // 2 units per character; the 128-character cap is by count
    input.value = "  heads down  ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.payload.custom_status).toBe("heads down");
    expect(card()).toBeNull();

    // Reopen: the text set through the card is still there, and clearable.
    trigger().click();
    expect(q("[data-testid='spc-custom-line']")?.textContent).toBe("heads down");
    expect(q<HTMLInputElement>("[data-testid='spc-custom-input']")!.value).toBe("heads down");
    const clear = q<HTMLButtonElement>("[data-testid='spc-custom-clear']")!;
    expect(clear.hidden).toBe(false);
    clear.click();
    expect(loadCustomStatus()).toBe("");
  });

  it("shows a hint and does not send an over-limit custom status", () => {
    trigger().click();
    const input = q<HTMLInputElement>("[data-testid='spc-custom-input']")!;
    const hint = q<HTMLElement>("[data-testid='spc-custom-hint']")!;
    expect(hint.textContent).toBe("Up to 128 characters, on one line.");
    const over = "x".repeat(200); // a value maxlength did not truncate
    input.value = over;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(ws.send).not.toHaveBeenCalled();
    expect(hint.textContent).toBe("Custom status must be at most 128 characters.");
    // The card stays open with the typed text so it can be shortened.
    expect(card()).not.toBeNull();
    expect(input.value).toBe(over);
  });

  it("clearing after typing sends a single save, not a blur commit first", () => {
    trigger().click();
    const input = q<HTMLInputElement>("[data-testid='spc-custom-input']")!;
    input.focus();
    input.value = "half typ";
    const clear = q<HTMLButtonElement>("[data-testid='spc-custom-clear']")!;
    const md = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    clear.dispatchEvent(md);
    expect(md.defaultPrevented).toBe(true);
    clear.click();
    expect(loadCustomStatus()).toBe("");
    expect(
      (ws.send as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0].payload.custom_status === "half typ",
      ),
    ).toHaveLength(0);
  });

  it("status items are a menu of menuitemradio with a roving tabindex", () => {
    saveUserStatus("idle");
    trigger().click();
    expect(q("[role='menu']")).not.toBeNull();
    const items = [...document.body.querySelectorAll<HTMLElement>("[role='menuitemradio']")];
    expect(items.length).toBe(4);
    expect(items.map((i) => i.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(document.activeElement).toBe(items[1]);
  });

  it("arrows (wrapping), Home and End move focus without saving; Enter commits", () => {
    trigger().click();
    const items = [...document.body.querySelectorAll<HTMLElement>("[role='menuitemradio']")];
    expect(document.activeElement).toBe(items[0]);
    press("ArrowUp");
    expect(document.activeElement).toBe(items[3]);
    press("ArrowDown");
    expect(document.activeElement).toBe(items[0]);
    press("End");
    expect(document.activeElement).toBe(items[3]);
    press("Home");
    expect(document.activeElement).toBe(items[0]);
    press("ArrowDown");
    press("ArrowDown");
    expect(document.activeElement).toBe(items[2]);
    expect(loadUserStatus()).toBe("online");
    expect(ws.send).not.toHaveBeenCalled();
    expect(card()).not.toBeNull();
    // Enter on a button is its click.
    (document.activeElement as HTMLElement).click();
    expect(loadUserStatus()).toBe("dnd");
    expect(card()).toBeNull();
  });

  it("opening offline puts focus on the card, not a disabled item", () => {
    setConnectionStatus("disconnected");
    trigger().click();
    expect(document.activeElement).toBe(card());
  });

  it("opening Settings or changing the view closes the card", () => {
    trigger().click();
    uiStore.setState((p) => ({ ...p, settingsOpen: true }));
    uiStore.flush();
    expect(card()).toBeNull();
    uiStore.setState((p) => ({ ...p, settingsOpen: false }));
    uiStore.flush();

    trigger().click();
    uiStore.setState((p) => ({ ...p, activeView: "friends" as never }));
    uiStore.flush();
    expect(card()).toBeNull();
    uiStore.setState((p) => ({ ...p, activeView: null }));
  });

  it("Edit Profile opens Settings on the Account tab", () => {
    trigger().click();
    q<HTMLButtonElement>("[data-testid='spc-edit-profile']")!.click();
    expect(uiStore.getState().settingsOpen).toBe(true);
    expect(uiStore.getState().settingsTab).toBe("Account");
    expect(card()).toBeNull();
  });

  describe("Copy User ID (Developer Mode only, like the member menu)", () => {
    let writeText: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    });
    afterEach(() => savePref("developerMode", false));

    it("is absent with Developer Mode off", () => {
      trigger().click();
      expect(q("[data-testid='spc-copy-id']")).toBeNull();
    });

    it("copies the id with Developer Mode on", () => {
      savePref("developerMode", true);
      trigger().click();
      q<HTMLButtonElement>("[data-testid='spc-copy-id']")!.click();
      expect(writeText).toHaveBeenCalledWith("7");
      expect(card()).toBeNull();
    });
  });

  it("Escape closes the card and returns focus to the button", () => {
    trigger().click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(card()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("an outside click closes the card; the status dot's click counts as outside", () => {
    trigger().click();
    document.body.click();
    expect(card()).toBeNull();

    trigger().click();
    expect(card()).not.toBeNull();
    q<HTMLElement>(".status-picker-dot")!.click();
    expect(card()).toBeNull();
    // ...and the dot still opens its own dropdown.
    expect(q(".status-picker-dropdown--open")).not.toBeNull();
  });

  it("a click inside the card does not close it", () => {
    trigger().click();
    q<HTMLElement>("[data-testid='spc-name']")!.click();
    expect(card()).not.toBeNull();
  });

  it("keeps a single card open", () => {
    trigger().click();
    const container2 = document.createElement("div");
    document.body.appendChild(container2);
    const second = createUserBar({});
    second.mount(container2);
    container2.querySelector<HTMLButtonElement>("[data-testid='user-bar-profile']")!.click();
    expect(document.body.querySelectorAll("[data-testid='self-profile-card']").length).toBe(1);
    second.destroy?.();
    container2.remove();
  });

  it("is inert for status changes while the connection is down", () => {
    setConnectionStatus("disconnected");
    trigger().click();
    expect(q<HTMLButtonElement>("[data-testid='spc-status-dnd']")!.disabled).toBe(true);
    expect(q<HTMLInputElement>("[data-testid='spc-custom-input']")!.disabled).toBe(true);
  });

  // Edge case (a): a status change arrives from the server (another device)
  // while the card is open.
  it("follows a status and custom status change that arrives while open", () => {
    trigger().click();
    expect(q("[data-testid='spc-status-online']")?.getAttribute("aria-checked")).toBe("true");

    saveUserStatus("dnd");
    expect(q("[data-testid='spc-status-dnd']")?.getAttribute("aria-checked")).toBe("true");
    expect(q("[data-testid='spc-status-online']")?.getAttribute("aria-checked")).toBe("false");

    // The server echo (another device) lands in the members store.
    membersStore.setState((p) => ({
      ...p,
      members: new Map(p.members).set(7, {
        ...(p.members.get(7) ?? ({ id: 7, username: "alice" } as never)),
        customStatus: "back at 3",
      }),
    }));
    membersStore.flush();
    expect(q<HTMLInputElement>("[data-testid='spc-custom-input']")!.value).toBe("back at 3");
    expect(q("[data-testid='spc-custom-line']")?.textContent).toBe("back at 3");
  });

  // Edge case (b): the bar goes away (or is rebuilt) while the card is open.
  it("destroying the bar removes the card and every listener it added", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    trigger().click();
    const added = add.mock.calls.filter(([, , o]) => typeof o === "object" && o?.signal);
    expect(added.length).toBeGreaterThan(0);
    const signals = added.map(([, , o]) => (o as AddEventListenerOptions).signal!);

    comp.destroy?.();
    expect(card()).toBeNull();
    expect(signals.every((s) => s.aborted)).toBe(true);
    add.mockRestore();
    remove.mockRestore();

    // Nothing left to react: a stale Escape / status push does not throw or
    // resurrect anything.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    saveUserStatus("idle");
    expect(card()).toBeNull();

    // A rebuilt bar starts clean and opens exactly one card.
    comp = createUserBar({ ws, presenceSender: createPresenceSender(ws, createPresenceLimiter()) });
    comp.mount(container);
    trigger().click();
    expect(document.body.querySelectorAll("[data-testid='self-profile-card']").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Status timers, Clear after and the emoji button (3C-5b)
// ---------------------------------------------------------------------------

const frames = (w: WsClient): Array<{ payload: Record<string, unknown> }> =>
  (w.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
const press = (k: string): void => {
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
  );
};
const byId = <T extends HTMLElement>(id: string): T => q<T>(`[data-testid='${id}']`)!;

/** Opens the card, types "lunch" and moves focus to Clear after; nothing is sent yet. */
function typeLunchThenFocusClearAfter(ws: WsClient): HTMLSelectElement {
  trigger().click();
  const input = byId<HTMLInputElement>("spc-custom-input");
  const select = byId<HTMLSelectElement>("spc-clear-after");
  input.focus();
  input.value = "lunch";
  input.dispatchEvent(new FocusEvent("blur", { relatedTarget: select }));
  expect(ws.send).not.toHaveBeenCalled();
  return select;
}

function setOwn(customStatus: string, expiresAt: string | null | undefined): void {
  membersStore.setState((p) => ({
    ...p,
    members: new Map(p.members).set(7, {
      id: 7,
      username: "alice",
      status: "online",
      customStatus,
      ...(expiresAt === undefined ? {} : { customStatusExpiresAt: expiresAt }),
    } as never),
  }));
  membersStore.flush();
}

async function openPicker(): Promise<HTMLElement> {
  byId<HTMLButtonElement>("spc-custom-emoji").click();
  await vi.dynamicImportSettled();
  return card()!.querySelector<HTMLElement>(".emoji-picker")!;
}
const firstCell = (picker: HTMLElement): HTMLElement =>
  picker.querySelector<HTMLElement>(".ep-emoji")!;

function commitVia(mount: () => void, option: string, text = "heads down"): void {
  mount();
  trigger().click();
  const select = byId<HTMLSelectElement>("spc-clear-after");
  select.value = option;
  const input = byId<HTMLInputElement>("spc-custom-input");
  input.value = text;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

describe("SelfProfileCard: timers, Clear after, emoji", () => {
  let container: HTMLDivElement;
  let comp: ReturnType<typeof createUserBar>;
  let ws: WsClient;

  beforeAll(async () => {
    await loadEmojiCatalog();
  });

  /** A fresh bar with its own presence limiter, so each case's first send
   *  goes straight out. */
  const commit = (option: string, text?: string): void => commitVia(mountBar, option, text);

  function mountBar(): void {
    comp?.destroy?.();
    ws = mockWs();
    comp = createUserBar({ ws, presenceSender: createPresenceSender(ws, createPresenceLimiter()) });
    comp.mount(container);
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    setConnectionStatus("connected");
    setUser();
    membersStore.setState((p) => ({
      ...p,
      members: new Map([[7, { id: 7, username: "alice", status: "online" } as never]]),
    }));
    membersStore.flush();
    mountBar();
  });

  afterEach(() => {
    vi.useRealTimers();
    comp.destroy?.();
    container.remove();
    membersStore.setState((p) => ({ ...p, members: new Map() }));
    setConnectionStatus("disconnected");
    resetAuthState();
  });

  describe("status durations", () => {
    it("Idle, Do Not Disturb and Invisible offer 15 minutes to 3 days and Forever; Online does not", () => {
      trigger().click();
      expect(q("[data-testid='spc-durations-online']")).toBeNull();
      for (const status of ["idle", "dnd", "invisible"]) {
        const labels = [
          ...document.body.querySelectorAll(
            `[data-testid='spc-durations-${status}'] [role='menuitem']`,
          ),
        ].map((el) => el.textContent);
        expect(labels).toEqual([
          "For 15 minutes",
          "For 1 hour",
          "For 8 hours",
          "For 24 hours",
          "For 3 days",
          "Forever",
        ]);
        expect(byId(`spc-durations-${status}`).hidden).toBe(true);
      }
    });

    it("picking a duration saves and sends the status and stores the expiry", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 9, 17, 10, 0, 0));
      trigger().click();
      byId("spc-chevron-dnd").click();
      expect(byId("spc-durations-dnd").hidden).toBe(false);
      byId<HTMLButtonElement>("spc-duration-dnd-1h").click();

      expect(loadUserStatus()).toBe("dnd");
      expect(frames(ws)).toHaveLength(1);
      expect(frames(ws)[0]!.payload).toEqual({ status: "dnd" });
      expect(loadStatusTimer()).toEqual({
        status: "dnd",
        until: new Date(2026, 9, 17, 11).getTime(),
      });
      expect(card()).toBeNull();
    });

    it("the card shows 'Until HH:MM' under the running status", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 9, 17, 10, 0, 0));
      trigger().click();
      byId<HTMLButtonElement>("spc-duration-idle-8h").click();

      trigger().click();
      const until = byId("spc-until-idle");
      expect(until.hidden).toBe(false);
      expect(until.textContent).toMatch(/^Until 6:00\sPM$/);
      expect(byId("spc-until-dnd").hidden).toBe(true);

      // It follows a change while open: Online has no timer line.
      saveUserStatus("online");
      expect(byId("spc-until-idle").hidden).toBe(true);
    });

    it("Forever, and a plain click on the row, store no timer", () => {
      trigger().click();
      byId<HTMLButtonElement>("spc-duration-dnd-forever").click();
      expect(loadUserStatus()).toBe("dnd");
      expect(loadStatusTimer()).toBeNull();

      saveStatusTimer("dnd", Date.now() + 3_600_000);
      trigger().click();
      byId<HTMLButtonElement>("spc-status-idle").click();
      expect(loadUserStatus()).toBe("idle");
      expect(loadStatusTimer()).toBeNull(); // a manual change cancels the timer
    });

    it("the duration options are reachable by keyboard inside the menu", () => {
      trigger().click();
      const dnd = byId<HTMLButtonElement>("spc-status-dnd");
      dnd.focus();
      expect(dnd.getAttribute("aria-keyshortcuts")).toBe("ArrowRight");

      press("ArrowRight");
      const first = byId<HTMLButtonElement>("spc-duration-dnd-15m");
      expect(byId("spc-durations-dnd").hidden).toBe(false);
      expect(document.activeElement).toBe(first);
      expect(first.getAttribute("role")).toBe("menuitem");
      expect(first.tabIndex).toBe(-1);

      press("ArrowDown");
      expect(document.activeElement).toBe(byId("spc-duration-dnd-1h"));
      press("End");
      expect(document.activeElement).toBe(byId("spc-status-invisible"));
      press("ArrowUp");
      expect(document.activeElement).toBe(byId("spc-duration-dnd-forever"));
      press("Home");
      press("ArrowDown");
      press("ArrowDown");
      press("ArrowDown");
      expect(document.activeElement).toBe(byId("spc-duration-dnd-15m"));

      press("ArrowLeft");
      expect(byId("spc-durations-dnd").hidden).toBe(true);
      expect(document.activeElement).toBe(dnd);

      // Enter on a duration is its click: commit and close.
      press("ArrowRight");
      press("ArrowDown");
      (document.activeElement as HTMLElement).click();
      expect(loadUserStatus()).toBe("dnd");
      expect(loadStatusTimer()?.status).toBe("dnd");
      expect(card()).toBeNull();
    });

    it("ArrowRight does nothing on Online, and the roving order is unchanged while collapsed", () => {
      trigger().click();
      byId<HTMLButtonElement>("spc-status-online").focus();
      press("ArrowRight");
      expect(document.activeElement).toBe(byId("spc-status-online"));
      press("ArrowDown");
      expect(document.activeElement).toBe(byId("spc-status-idle"));
      press("ArrowDown");
      expect(document.activeElement).toBe(byId("spc-status-dnd"));
    });

    it("is inert while the connection is down", () => {
      setConnectionStatus("disconnected");
      trigger().click();
      expect(byId<HTMLButtonElement>("spc-duration-dnd-1h").disabled).toBe(true);
      expect(byId<HTMLButtonElement>("spc-chevron-dnd").disabled).toBe(true);
      expect(byId<HTMLSelectElement>("spc-clear-after").disabled).toBe(true);
    });
  });

  describe("custom status Clear after", () => {
    it("offers Today, 4 hours, 1 hour, 30 minutes and Don't clear, defaulting to Don't clear", () => {
      trigger().click();
      const select = byId<HTMLSelectElement>("spc-clear-after");
      expect([...select.options].map((o) => o.textContent)).toEqual([
        "Today",
        "4 hours",
        "1 hour",
        "30 minutes",
        "Don't clear",
      ]);
      expect(select.value).toBe("never");
      expect(document.body.querySelector("label[for='spc-clear-after']")?.textContent).toBe(
        "Clear after",
      );
    });

    it.each([
      ["4h", 14400],
      ["1h", 3600],
      ["30m", 1800],
    ])("%s sends custom_status_expires_in %i", (option, seconds) => {
      commit(option);
      expect(frames(ws)[0]!.payload).toEqual({
        status: "online",
        custom_status: "heads down",
        custom_status_expires_in: seconds,
      });
    });

    it("Today is the seconds to local midnight", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 9, 17, 10, 0, 0));
      commit("today");
      expect(frames(ws)[0]!.payload.custom_status_expires_in).toBe(14 * 3600);
    });

    // Edge case (b): 23:59:30 is 30 seconds from midnight; the server's minimum is 60.
    it("Today chosen at 23:59:30 still sends at least 60 seconds", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 9, 17, 23, 59, 30));
      commit("today");
      expect(frames(ws)[0]!.payload.custom_status_expires_in).toBe(60);
    });

    it("Don't clear sends no expiry field", () => {
      commit("never");
      expect(frames(ws)[0]!.payload).toEqual({ status: "online", custom_status: "heads down" });
    });

    it("clearing the text drops the expiry even with a Clear after chosen", () => {
      commit("1h", "x");
      expect(frames(ws)[0]!.payload.custom_status_expires_in).toBe(3600);
      membersStore.flush();
      expect(membersStore.getState().members.get(7)?.customStatusExpiresAt).not.toBeNull();

      trigger().click();
      byId<HTMLSelectElement>("spc-clear-after").value = "1h";
      byId<HTMLButtonElement>("spc-custom-clear").click();
      membersStore.flush();
      const own = membersStore.getState().members.get(7);
      expect(own?.customStatus).toBe("");
      expect(own?.customStatusExpiresAt).toBeNull();
    });

    it("changing Clear after restates the text already set, with the new expiry", () => {
      trigger().click();
      const input = byId<HTMLInputElement>("spc-custom-input");
      input.value = "in a meeting";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(frames(ws)).toHaveLength(1);

      // The retry carries the later choice once the limiter window reopens;
      // the optimistic apply shows it at once.
      trigger().click();
      const select = byId<HTMLSelectElement>("spc-clear-after");
      select.value = "1h";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      membersStore.flush();
      const own = membersStore.getState().members.get(7);
      expect(own?.customStatus).toBe("in a meeting");
      expect(own?.customStatusExpiresAt).not.toBeNull();
    });

    it("changing it with no text set sends nothing", () => {
      trigger().click();
      const select = byId<HTMLSelectElement>("spc-clear-after");
      select.value = "1h";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      expect(ws.send).not.toHaveBeenCalled();
    });

    describe("the 'Clears at' line", () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(2026, 9, 17, 12, 0, 0));
      });

      it("renders 'Clears at 2:30 PM' from your member entry", () => {
        setOwn("in a meeting", new Date(2026, 9, 17, 14, 30).toISOString());
        trigger().click();
        const line = byId("spc-clears-line");
        expect(line.hidden).toBe(false);
        expect(line.textContent).toMatch(/^Clears at 2:30\sPM$/);
      });

      it("renders 'Clears today' for the end-of-day choice", () => {
        setOwn("lunch", new Date(2026, 9, 18, 0, 0, 0).toISOString());
        trigger().click();
        expect(byId("spc-clears-line").textContent).toBe("Clears today");
      });

      it("names the weekday when it is not today", () => {
        setOwn("away", new Date(2026, 9, 19, 9, 0).toISOString());
        trigger().click();
        expect(byId("spc-clears-line").textContent).toMatch(/^Clears Mon at 9:00\sAM$/);
      });

      it("falls back to the instant auth_ok gave when the entry says nothing", () => {
        setOwn("in a meeting", undefined);
        authStore.setState((s) => ({
          ...s,
          user: {
            ...s.user!,
            custom_status: "in a meeting",
            custom_status_expires_at: new Date(2026, 9, 17, 15, 0).toISOString(),
          },
        }));
        trigger().click();
        expect(byId("spc-clears-line").textContent).toMatch(/^Clears at 3:00\sPM$/);
      });

      it("an explicit 'no expiry' on the entry beats a stale auth_ok instant", () => {
        setOwn("in a meeting", null);
        authStore.setState((s) => ({
          ...s,
          user: {
            ...s.user!,
            custom_status_expires_at: new Date(2026, 9, 17, 15, 0).toISOString(),
          },
        }));
        trigger().click();
        expect(byId("spc-clears-line").hidden).toBe(true);
      });

      it("is hidden with no expiry or no text", () => {
        setOwn("plain", null);
        trigger().click();
        expect(byId("spc-clears-line").hidden).toBe(true);
        card()!.remove();
        comp.destroy?.();
        mountBar();
        setOwn("", new Date(2026, 9, 17, 14).toISOString());
        trigger().click();
        expect(byId("spc-clears-line").hidden).toBe(true);
      });

      it("hides an already-expired status without waiting for the server to clear it", () => {
        setOwn("in a meeting", new Date(2026, 9, 17, 11, 59).toISOString());
        trigger().click();
        expect(byId("spc-clears-line").hidden).toBe(true);
        expect(byId("spc-custom-line").hidden).toBe(true);
        expect(byId<HTMLInputElement>("spc-custom-input").value).toBe("");
      });

      it("shows no clearing timer of its own: nothing is scheduled for the expiry", () => {
        const spy = vi.spyOn(globalThis, "setTimeout");
        setOwn("in a meeting", new Date(2026, 9, 17, 12, 30).toISOString());
        trigger().click();
        const longTimers = spy.mock.calls.filter(([, ms]) => (ms ?? 0) >= 60_000);
        expect(longTimers).toHaveLength(0);
        spy.mockRestore();
      });
    });
  });

  describe("submenu semantics and pending text", () => {
    it("the timed rows carry haspopup/expanded; the list is a labelled menu; Escape closes just the list", () => {
      trigger().click();
      const dnd = byId<HTMLButtonElement>("spc-status-dnd");
      expect(dnd.getAttribute("aria-haspopup")).toBe("menu");
      expect(dnd.getAttribute("aria-expanded")).toBe("false");
      expect(byId("spc-status-online").hasAttribute("aria-haspopup")).toBe(false);
      const list = byId("spc-durations-dnd");
      expect(list.getAttribute("role")).toBe("menu");
      expect(list.getAttribute("aria-label")).toBe("Do Not Disturb: choose how long");

      dnd.focus();
      press("ArrowRight");
      expect(dnd.getAttribute("aria-expanded")).toBe("true");
      expect(byId("spc-status-idle").getAttribute("aria-expanded")).toBe("false");

      press("Escape");
      expect(list.hidden).toBe(true);
      expect(dnd.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(dnd);
      expect(card()).not.toBeNull();
      // With nothing open, Escape closes the card as before.
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      expect(card()).toBeNull();
    });

    it("typed text is committed when an outside click closes the card with the picker open", async () => {
      trigger().click();
      const input = byId<HTMLInputElement>("spc-custom-input");
      input.focus();
      input.value = "  brb   soon ";
      await openPicker();
      input.blur(); // focus moved into the picker: no commit yet
      expect(ws.send).not.toHaveBeenCalled();

      document.body.click(); // outside click
      expect(card()).toBeNull();
      expect(frames(ws)).toHaveLength(1);
      expect(frames(ws)[0]!.payload.custom_status).toBe("brb soon");
    });

    it("the owner tearing the bar down with the picker open commits it too", async () => {
      trigger().click();
      byId<HTMLInputElement>("spc-custom-input").value = "away";
      await openPicker();
      comp.destroy?.();
      expect(frames(ws)[0]!.payload.custom_status).toBe("away");
    });

    it("text typed before moving to Clear after is still sent when the select changes nothing and the card closes", () => {
      typeLunchThenFocusClearAfter(ws);
      document.body.click(); // outside click, no change event on the select
      expect(card()).toBeNull();
      expect(frames(ws)).toHaveLength(1);
      expect(frames(ws)[0]!.payload.custom_status).toBe("lunch");
    });

    it("Escape still discards typed text: nothing is sent", () => {
      trigger().click();
      const input = byId<HTMLInputElement>("spc-custom-input");
      input.focus();
      input.value = "never mind";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(card()).toBeNull();
      expect(ws.send).not.toHaveBeenCalled();
    });

    it("an update held back while the picker was open applies when it closes and the field is left", async () => {
      trigger().click();
      const input = byId<HTMLInputElement>("spc-custom-input");
      await openPicker();
      setOwn("from another device", null);
      expect(input.value).toBe("");
      byId<HTMLButtonElement>("spc-custom-emoji").click(); // closes it, focus to the field
      expect(document.activeElement).toBe(input);
      input.blur();
      expect(input.value).toBe("from another device");
      expect(byId("spc-custom-line").textContent).toBe("from another device");
    });

    it("an update held back while the field was focused applies on blur", () => {
      trigger().click();
      const input = byId<HTMLInputElement>("spc-custom-input");
      input.focus();
      setOwn("remote text", null);
      expect(input.value).toBe("");
      input.blur();
      expect(input.value).toBe("remote text");
    });

    it("whitespace runs are collapsed before sending, like the server does", () => {
      commit("never", "  a \t  b   c ");
      expect(frames(ws)[0]!.payload.custom_status).toBe("a b c");
    });

    it("moving from the text to Clear after sends one frame, not two", () => {
      const select = typeLunchThenFocusClearAfter(ws);
      select.value = "1h";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      expect(frames(ws)).toHaveLength(1);
      expect(frames(ws)[0]!.payload).toMatchObject({
        custom_status: "lunch",
        custom_status_expires_in: 3600,
      });
    });

    it("does not overwrite the typed text from the store while the picker is open", async () => {
      trigger().click();
      const input = byId<HTMLInputElement>("spc-custom-input");
      input.value = "typing";
      await openPicker();
      setOwn("from another device", null);
      expect(input.value).toBe("typing");
    });
  });

  describe("emoji button", () => {
    it("opens the emoji picker inside the card and closes it again", async () => {
      trigger().click();
      const btn = byId<HTMLButtonElement>("spc-custom-emoji");
      expect(btn.getAttribute("aria-expanded")).toBe("false");
      const picker = await openPicker();
      expect(picker).not.toBeNull();
      expect(btn.getAttribute("aria-expanded")).toBe("true");
      expect(card()).not.toBeNull();
      btn.click();
      expect(card()!.querySelector(".emoji-picker")).toBeNull();
      expect(btn.getAttribute("aria-expanded")).toBe("false");
    });

    it("inserts the chosen emoji at the caret", async () => {
      trigger().click();
      const input = byId<HTMLInputElement>("spc-custom-input");
      input.value = "hello world";
      input.setSelectionRange(5, 5);
      const picker = await openPicker();
      const cell = firstCell(picker);
      const emoji = cell.dataset.emoji!;
      cell.click();
      expect(input.value).toBe(`hello${emoji} world`);
      expect(input.selectionStart).toBe(5 + emoji.length);
      expect(card()!.querySelector(".emoji-picker")).toBeNull();
      expect(document.activeElement).toBe(input);
      // Nothing is sent until the text is committed.
      expect(ws.send).not.toHaveBeenCalled();
    });

    it("replaces a selection and leaves the clear button showing", async () => {
      trigger().click();
      const input = byId<HTMLInputElement>("spc-custom-input");
      input.value = "abcdef";
      input.setSelectionRange(1, 4);
      const cell = firstCell(await openPicker());
      cell.click();
      expect(input.value).toBe(`a${cell.dataset.emoji}ef`);
      expect(byId<HTMLButtonElement>("spc-custom-clear").hidden).toBe(false);
    });

    it("respects the 128-character limit", async () => {
      trigger().click();
      const input = byId<HTMLInputElement>("spc-custom-input");
      const full = "x".repeat(128);
      input.value = full;
      input.setSelectionRange(128, 128);
      firstCell(await openPicker()).click();
      expect(input.value).toBe(full);

      // The limit counts characters like the server: with room for one, an
      // emoji of several characters is refused whole and a one-character
      // emoji fits, even when it takes two UTF-16 units.
      const chars = (s: string): number => [...s].length;
      input.value = "x".repeat(127);
      input.setSelectionRange(127, 127);
      const picker = await openPicker();
      const cells = [...picker.querySelectorAll<HTMLElement>(".ep-emoji")];
      const multi = cells.find((c) => chars(c.dataset.emoji!) > 1)!;
      multi.click();
      expect(input.value).toBe("x".repeat(127));

      const single = [...(await openPicker()).querySelectorAll<HTMLElement>(".ep-emoji")].find(
        (c) => chars(c.dataset.emoji!) === 1 && c.dataset.emoji!.length === 2,
      )!;
      single.click();
      expect(input.value).toBe("x".repeat(127) + single.dataset.emoji!);
      expect(chars(input.value)).toBe(128);
    });

    it("picking does not send half-typed text; Enter then commits it with the emoji", async () => {
      trigger().click();
      const input = byId<HTMLInputElement>("spc-custom-input");
      input.focus();
      input.value = "on it ";
      input.setSelectionRange(6, 6);
      const md = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      byId("spc-custom-emoji").dispatchEvent(md);
      expect(md.defaultPrevented).toBe(true);
      const cell = firstCell(await openPicker());
      input.blur(); // focus moving into the picker
      expect(ws.send).not.toHaveBeenCalled();
      cell.click();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(frames(ws)[0]!.payload.custom_status).toBe(`on it ${cell.dataset.emoji}`);
    });

    it("offers no server emoji: a custom status renders as plain text", async () => {
      const { setCustomEmoji } = await import("@stores/emoji.store");
      setCustomEmoji([{ id: 1, shortcode: "party", url: "/x.png" } as never], 0);
      trigger().click();
      const picker = await openPicker();
      expect(picker.querySelector(".ep-emoji-custom")).toBeNull();
      expect(picker.textContent).not.toContain("Server");
    });

    it("Escape in the picker closes only the picker", async () => {
      trigger().click();
      const picker = await openPicker();
      picker.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      expect(card()).not.toBeNull();
      expect(card()!.querySelector(".emoji-picker")).toBeNull();
      // A second Escape closes the card.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(card()).toBeNull();
    });

    it("closing the card takes the picker with it", async () => {
      trigger().click();
      await openPicker();
      trigger().click();
      expect(card()).toBeNull();
      expect(document.body.querySelector(".emoji-picker")).toBeNull();
    });

    it("closing the card while the picker is still loading mounts nothing", async () => {
      trigger().click();
      byId<HTMLButtonElement>("spc-custom-emoji").click();
      trigger().click(); // the card goes away before the picker's code arrives
      await vi.dynamicImportSettled();
      expect(card()).toBeNull();
      expect(document.body.querySelector(".emoji-picker")).toBeNull();
    });

    it("a second click on the emoji button while it loads cancels the open", async () => {
      trigger().click();
      byId<HTMLButtonElement>("spc-custom-emoji").click();
      byId<HTMLButtonElement>("spc-custom-emoji").click();
      await vi.dynamicImportSettled();
      expect(card()!.querySelector(".emoji-picker")).toBeNull();
    });
  });
});
