import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { authStore, clearAuth } from "@stores/auth.store";
import { setConnectionStatus } from "@stores/ui.store";
import { loadUserStatus, saveUserStatus } from "@lib/presence/userStatus";
import { createPagePresence } from "../../src/pages/main-page/pagePresence";
import type { PageApi, PageState } from "../../src/pages/main-page/pageState";

type ServerStatus = "online" | "idle" | "dnd" | "invisible" | undefined;

function setServerStatus(status: ServerStatus): void {
  authStore.setState(() => ({
    token: "tok",
    user: { id: 1, username: "alice", avatar: null, role: "member", status },
    serverName: "s",
    motd: null,
    isAuthenticated: true,
  }));
  authStore.flush();
}

function makePresence() {
  const send = vi.fn();
  const st = { presenceSender: { send }, unsubscribers: [] as Array<() => void> };
  const presence = createPagePresence(st as unknown as PageState, {} as PageApi);
  return { presence, send, stop: () => st.unsubscribers.forEach((u) => u()) };
}

describe("page presence on connect", () => {
  beforeEach(() => {
    localStorage.clear();
    setConnectionStatus("connected");
  });
  afterEach(() => {
    clearAuth();
  });

  it("adopts a status another device chose instead of sending the saved one over it", () => {
    setServerStatus("dnd");
    const { presence, send, stop } = makePresence();
    presence.restoreSavedPresence();
    expect(send).not.toHaveBeenCalled();
    expect(loadUserStatus()).toBe("dnd");
    stop();
  });

  it("sends a status picked on this device while the socket was down", () => {
    setServerStatus("online");
    const { presence, send, stop } = makePresence();
    presence.restoreSavedPresence();
    setConnectionStatus("reconnecting");
    saveUserStatus("dnd");
    setConnectionStatus("connected");
    presence.restoreSavedPresence();
    expect(send).toHaveBeenCalledExactlyOnceWith("dnd");
    expect(loadUserStatus()).toBe("dnd");
    stop();
  });

  it("still answers a server that reports no status with the saved one", () => {
    saveUserStatus("dnd");
    setServerStatus(undefined);
    const { presence, send, stop } = makePresence();
    presence.restoreSavedPresence();
    expect(send).toHaveBeenCalledExactlyOnceWith("dnd");
    stop();
  });
});
