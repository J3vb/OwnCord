import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { authStore } from "@stores/auth.store";
import { membersStore } from "@stores/members.store";
import { uiStore, setConnectionStatus } from "@stores/ui.store";
import { createUserBar } from "@components/UserBar";
import { loadCustomStatus, loadUserStatus, saveUserStatus } from "@lib/userStatus";
import { savePref } from "@lib/preferences";
import { createPresenceSender } from "@lib/presence";
import { createPresenceLimiter } from "@lib/rate-limiter";
import type { WsClient } from "@lib/ws";

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
    authStore.setState(() => ({
      token: null,
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: false,
    }));
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

  it("the custom status can be set (trimmed, capped at 128) and cleared", () => {
    trigger().click();
    const input = q<HTMLInputElement>("[data-testid='spc-custom-input']")!;
    expect(input.maxLength).toBe(128);
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
    const key = (k: string): void => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
      );
    };
    expect(document.activeElement).toBe(items[0]);
    key("ArrowUp");
    expect(document.activeElement).toBe(items[3]);
    key("ArrowDown");
    expect(document.activeElement).toBe(items[0]);
    key("End");
    expect(document.activeElement).toBe(items[3]);
    key("Home");
    expect(document.activeElement).toBe(items[0]);
    key("ArrowDown");
    key("ArrowDown");
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
