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
    ws = mockWs();
    comp = createUserBar({ ws, presenceSender: createPresenceSender(ws, createPresenceLimiter()) });
    comp.mount(container);
  });

  afterEach(() => {
    comp.destroy?.();
    container.remove();
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

    // Reopen with the status standing, then clear it.
    setUser("heads down");
    trigger().click();
    expect(q("[data-testid='spc-custom-line']")?.textContent).toBe("heads down");
    q<HTMLButtonElement>("[data-testid='spc-custom-clear']")!.click();
    // Saved at once; the frame itself waits on the shared presence limiter.
    expect(loadCustomStatus()).toBe("");
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

    setUser("on a call");
    authStore.flush();
    expect(q("[data-testid='spc-custom-line']")?.textContent).toBe("on a call");
    expect(q<HTMLInputElement>("[data-testid='spc-custom-input']")!.value).toBe("on a call");

    // A presence rollback through the members store reaches the card too.
    membersStore.setState((p) => ({
      ...p,
      members: new Map(p.members).set(7, {
        ...(p.members.get(7) ?? ({ id: 7, username: "alice" } as never)),
        customStatus: "back at 3",
      }),
    }));
    membersStore.flush();
    expect(q<HTMLInputElement>("[data-testid='spc-custom-input']")!.value).toBe("back at 3");
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
