import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { authStore, clearAuth } from "@stores/auth.store";
import { setConnectionStatus } from "@stores/ui.store";
import {
  loadStatusTimer,
  loadUserStatus,
  saveStatusTimer,
  saveUserStatus,
} from "@lib/presence/userStatus";
import { setChannelMutesHost } from "@lib/prefs/channelMutes";
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

const stops: Array<() => void> = [];

function makePresence() {
  const send = vi.fn();
  const st = { presenceSender: { send }, unsubscribers: [] as Array<() => void> };
  const presence = createPagePresence(st as unknown as PageState, {} as PageApi);
  stops.push(() => st.unsubscribers.forEach((u) => u()));
  return { presence, send };
}

/** The socket drops, `whileDown` happens, and it comes back to a server saying `status`. */
function reconnectTo(status: ServerStatus, whileDown: () => void = () => undefined): void {
  setConnectionStatus("reconnecting");
  whileDown();
  setServerStatus(status);
  setConnectionStatus("connected");
}

describe("page presence on connect", () => {
  beforeEach(() => {
    localStorage.clear();
    setChannelMutesHost("one.example");
    setConnectionStatus("connected");
  });
  afterEach(() => {
    stops.splice(0).forEach((stop) => stop());
    setChannelMutesHost(null);
    clearAuth();
  });

  it("adopts a status another device chose instead of sending the saved one over it", () => {
    setServerStatus("dnd");
    const { presence, send } = makePresence();
    presence.restoreSavedPresence();
    expect(send).not.toHaveBeenCalled();
    expect(loadUserStatus()).toBe("dnd");
  });

  it("sends nothing and keeps the saved status when the server already agrees", () => {
    setServerStatus("online");
    const { presence, send } = makePresence();
    presence.restoreSavedPresence();
    expect(send).not.toHaveBeenCalled();
    expect(loadUserStatus()).toBe("online");
  });

  it("sends a status picked on this device while the socket was down", () => {
    setServerStatus("online");
    const { presence, send } = makePresence();
    presence.restoreSavedPresence();
    reconnectTo("online", () => saveUserStatus("dnd"));
    presence.restoreSavedPresence();
    expect(send).toHaveBeenCalledExactlyOnceWith("dnd");
    expect(loadUserStatus()).toBe("dnd");
  });

  it("adopts another device's later choice over one made here while connected", () => {
    setServerStatus("online");
    const { presence, send } = makePresence();
    presence.restoreSavedPresence();
    saveUserStatus("dnd");
    reconnectTo("invisible");
    presence.restoreSavedPresence();
    expect(send).not.toHaveBeenCalled();
    expect(loadUserStatus()).toBe("invisible");
  });

  it("does not take a return from auto-idle while the socket was down for a pick", () => {
    setServerStatus("online");
    const { presence, send } = makePresence();
    presence.restoreSavedPresence();
    saveUserStatus("idle", "auto");
    reconnectTo("dnd", () => saveUserStatus("online"));
    presence.restoreSavedPresence();
    expect(send).not.toHaveBeenCalled();
    expect(loadUserStatus()).toBe("dnd");
  });

  it("adopts another device's choice while this one sits in auto-idle", () => {
    setServerStatus("online");
    const { presence, send } = makePresence();
    presence.restoreSavedPresence();
    saveUserStatus("idle", "auto");
    reconnectTo("dnd");
    presence.restoreSavedPresence();
    expect(send).not.toHaveBeenCalled();
    expect(loadUserStatus()).toBe("dnd");
  });

  it("keeps a running timer when the server agrees, and ends it on adoption", () => {
    setServerStatus("online");
    const { presence } = makePresence();
    presence.restoreSavedPresence();
    saveUserStatus("dnd");
    saveStatusTimer("dnd", Date.now() + 3_600_000);
    reconnectTo("dnd");
    presence.restoreSavedPresence();
    expect(loadStatusTimer()?.status).toBe("dnd");
    reconnectTo("online");
    presence.restoreSavedPresence();
    expect(loadUserStatus()).toBe("online");
    expect(loadStatusTimer()).toBeNull();
  });

  it("carries the saved status and its timer to another server instead of adopting that one's", () => {
    setServerStatus("online");
    const first = makePresence();
    first.presence.restoreSavedPresence();
    saveUserStatus("dnd");
    saveStatusTimer("dnd", Date.now() + 3_600_000);

    setChannelMutesHost("two.example");
    setServerStatus("online");
    const second = makePresence();
    second.presence.restoreSavedPresence();
    expect(second.send).toHaveBeenCalledExactlyOnceWith("dnd");
    expect(loadUserStatus()).toBe("dnd");
    expect(loadStatusTimer()?.status).toBe("dnd");

    // Back on the first server, which still holds Do Not Disturb: nothing to do.
    setChannelMutesHost("one.example");
    setServerStatus("dnd");
    const back = makePresence();
    back.presence.restoreSavedPresence();
    expect(back.send).not.toHaveBeenCalled();
    expect(loadStatusTimer()?.status).toBe("dnd");
  });

  it("still answers a server that reports no status with the saved one", () => {
    saveUserStatus("dnd");
    setServerStatus(undefined);
    const { presence, send } = makePresence();
    presence.restoreSavedPresence();
    expect(send).toHaveBeenCalledExactlyOnceWith("dnd");
  });

  it("answers a server that reports idle with the saved status", () => {
    saveUserStatus("dnd");
    setServerStatus("idle");
    const { presence, send } = makePresence();
    presence.restoreSavedPresence();
    expect(send).toHaveBeenCalledExactlyOnceWith("dnd");
    expect(loadUserStatus()).toBe("dnd");
  });
});
