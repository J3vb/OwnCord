import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { UserStatus } from "@lib/types";
import { authStore } from "@stores/auth.store";
import { addMember, membersStore, setMembers, updatePresence } from "@stores/members.store";
import { startStatusTimerWatcher } from "@lib/presence/statusTimer";
import { clampExpiresIn, clearAfterSeconds, type ClearAfterId } from "@lib/text/statusChoices";
import {
  clearStatusTimer,
  loadStatusTimer,
  loadUserStatus,
  loadUserStatusOrigin,
  saveStatusTimer,
  saveUserStatus,
} from "@lib/presence/userStatus";
import { savePref } from "@lib/prefs/preferences";
import { resetAuthState, seedOnlineMember } from "../helpers/storeSeeds";

const HOUR = 60 * 60_000;
const START = new Date(2026, 9, 17, 10, 0, 0).getTime();

function setUser(status?: "online" | "idle" | "dnd" | "invisible"): void {
  authStore.setState(() => ({
    token: "tok",
    user: { id: 7, username: "alice", avatar: null, role: "member", status },
    serverName: "S",
    motd: null,
    isAuthenticated: true,
  }));
  authStore.flush();
}

function setOwnPresence(status: "online" | "idle" | "dnd" | "invisible" | "offline"): void {
  updatePresence(7, status);
  membersStore.flush();
}

/** A timed status as the card's duration choice leaves it. */
function pickTimed(status: "idle" | "dnd" | "invisible", ms: number): void {
  saveUserStatus(status);
  saveStatusTimer(status, Date.now() + ms);
}

describe("status timer watcher", () => {
  let onRevert: Mock<(status: UserStatus) => void>;

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(START);
    onRevert = vi.fn<(status: UserStatus) => void>();
    setUser();
    seedOnlineMember(7, "alice");
  });

  afterEach(() => {
    vi.useRealTimers();
    membersStore.setState((p) => ({ ...p, members: new Map() }));
    resetAuthState();
  });

  it("reverts to Online through the same path when the duration ends", () => {
    pickTimed("dnd", HOUR);
    setOwnPresence("dnd");
    const w = startStatusTimerWatcher({ onRevert });

    vi.advanceTimersByTime(HOUR - 1000);
    expect(onRevert).not.toHaveBeenCalled();
    expect(loadUserStatus()).toBe("dnd");

    vi.advanceTimersByTime(1000);
    expect(onRevert).toHaveBeenCalledExactlyOnceWith("online");
    expect(loadUserStatus()).toBe("online");
    expect(loadStatusTimer()).toBeNull();
    w.destroy();
  });

  it("a timer set after the watcher started is picked up", () => {
    const w = startStatusTimerWatcher({ onRevert });
    pickTimed("idle", 15 * 60_000);
    vi.advanceTimersByTime(15 * 60_000);
    expect(onRevert).toHaveBeenCalledExactlyOnceWith("online");
    w.destroy();
  });

  it("a manual status change cancels the timer", () => {
    pickTimed("dnd", HOUR);
    const w = startStatusTimerWatcher({ onRevert });
    vi.advanceTimersByTime(HOUR / 2);

    saveUserStatus("idle"); // picked by hand, no timer
    expect(loadStatusTimer()).toBeNull();
    vi.advanceTimersByTime(HOUR * 2);
    expect(onRevert).not.toHaveBeenCalled();
    expect(loadUserStatus()).toBe("idle");
    w.destroy();
  });

  it("a new timer replaces the old one, which never fires", () => {
    pickTimed("dnd", HOUR);
    const w = startStatusTimerWatcher({ onRevert });
    vi.advanceTimersByTime(HOUR / 2);
    pickTimed("dnd", 8 * HOUR);

    vi.advanceTimersByTime(HOUR); // the first timer's end has passed
    expect(onRevert).not.toHaveBeenCalled();
    vi.advanceTimersByTime(8 * HOUR);
    expect(onRevert).toHaveBeenCalledExactlyOnceWith("online");
    w.destroy();
  });

  it("a stored timer that ended while the app was closed reverts on startup", () => {
    pickTimed("invisible", HOUR);
    vi.setSystemTime(START + 2 * HOUR);
    expect(loadUserStatus()).toBe("invisible");

    const w = startStatusTimerWatcher({ onRevert });
    expect(onRevert).toHaveBeenCalledExactlyOnceWith("online");
    expect(loadUserStatus()).toBe("online");
    expect(loadStatusTimer()).toBeNull();
    w.destroy();
  });

  it("a restart inside the window keeps the timer and ends it on time", () => {
    pickTimed("dnd", HOUR);
    vi.setSystemTime(START + HOUR / 2);
    const w = startStatusTimerWatcher({ onRevert });
    expect(onRevert).not.toHaveBeenCalled();
    vi.advanceTimersByTime(HOUR / 2);
    expect(onRevert).toHaveBeenCalledExactlyOnceWith("online");
    w.destroy();
  });

  it("a leftover timer for a status that is no longer the saved one is dropped", () => {
    saveStatusTimer("dnd", START + HOUR); // saved status is still online
    const w = startStatusTimerWatcher({ onRevert });
    expect(loadStatusTimer()).toBeNull();
    vi.advanceTimersByTime(2 * HOUR);
    expect(onRevert).not.toHaveBeenCalled();
    w.destroy();
  });

  it("destroying the watcher stops the pending timer but keeps the stored one", () => {
    pickTimed("dnd", HOUR);
    const w = startStatusTimerWatcher({ onRevert });
    w.destroy();
    vi.advanceTimersByTime(2 * HOUR);
    expect(onRevert).not.toHaveBeenCalled();
    expect(loadStatusTimer()).not.toBeNull();
  });

  // Edge case (a): another device (or a reconnect) hands us a different status
  // while the timer is running.
  describe("a server-pushed status that differs from the timed one", () => {
    it("adopts it locally and cancels the timer when another device changes the status", () => {
      pickTimed("dnd", HOUR);
      setOwnPresence("dnd");
      const w = startStatusTimerWatcher({ onRevert });
      vi.advanceTimersByTime(HOUR / 4);

      setOwnPresence("idle");
      expect(loadStatusTimer()).toBeNull();
      expect(loadUserStatus()).toBe("idle"); // follows the other device, sends nothing
      vi.advanceTimersByTime(2 * HOUR);
      expect(onRevert).not.toHaveBeenCalled();
      w.destroy();
    });

    it("a reconnect's auth_ok with another status does not end the timer or change the saved status", () => {
      setUser("invisible");
      pickTimed("invisible", HOUR);
      const w = startStatusTimerWatcher({ onRevert });
      vi.advanceTimersByTime(HOUR / 4);

      // Another device made us Online while we were away; the reconnect says so.
      setUser("online");
      expect(loadStatusTimer()).not.toBeNull();
      // The saved status is untouched, so the page's restore step (which
      // compares it with auth_ok's) re-asserts it to the server.
      expect(loadUserStatus()).toBe("invisible");

      vi.advanceTimersByTime(HOUR);
      expect(onRevert).toHaveBeenCalledExactlyOnceWith("online");
      w.destroy();
    });

    it("a ready snapshot (roster replaced) is not another device speaking", () => {
      pickTimed("dnd", HOUR);
      const w = startStatusTimerWatcher({ onRevert });
      setMembers([{ id: 7, username: "alice", avatar: null, role: "member", status: "online" }]);
      membersStore.flush();
      expect(loadStatusTimer()).not.toBeNull();
      expect(loadUserStatus()).toBe("dnd");
      w.destroy();
    });

    it("ignores a late echo of the status we had before an optimistic timed pick", () => {
      setOwnPresence("online");
      const w = startStatusTimerWatcher({ onRevert });
      // The pick: saved, timer set, own entry updated optimistically.
      pickTimed("dnd", HOUR);
      setOwnPresence("dnd");
      vi.advanceTimersByTime(3000);
      setOwnPresence("online"); // the server still echoing our previous status
      expect(loadStatusTimer()).not.toBeNull();
      expect(loadUserStatus()).toBe("dnd");

      // Long after, the same report is a genuine change from another device.
      vi.advanceTimersByTime(20_000);
      setOwnPresence("dnd");
      setOwnPresence("online");
      expect(loadStatusTimer()).toBeNull();
      expect(loadUserStatus()).toBe("online");
      w.destroy();
    });

    it("adopts an Idle from another device as automatic, so auto-idle can bring it back", () => {
      pickTimed("dnd", HOUR);
      const w = startStatusTimerWatcher({ onRevert });
      setOwnPresence("idle");
      expect(loadUserStatus()).toBe("idle");
      expect(loadUserStatusOrigin()).toBe("auto");
      w.destroy();
    });

    it("adopts any other status from another device as a manual choice", () => {
      pickTimed("idle", HOUR);
      const w = startStatusTimerWatcher({ onRevert });
      setOwnPresence("dnd");
      expect(loadUserStatus()).toBe("dnd");
      expect(loadUserStatusOrigin()).toBe("manual");
      w.destroy();
    });

    it("reconciles an ignored echo at the end of the window when it was a real change", () => {
      setOwnPresence("online");
      const w = startStatusTimerWatcher({ onRevert });
      pickTimed("dnd", HOUR);
      setOwnPresence("dnd");
      vi.advanceTimersByTime(3000);
      setOwnPresence("online"); // looks like a straggler, ignored for now
      expect(loadStatusTimer()).not.toBeNull();

      vi.advanceTimersByTime(13_000); // past the window, still Online on the server
      expect(loadStatusTimer()).toBeNull();
      expect(loadUserStatus()).toBe("online");
      w.destroy();
    });

    it("the end-of-window look keeps the timer when the server has since caught up", () => {
      setOwnPresence("online");
      const w = startStatusTimerWatcher({ onRevert });
      pickTimed("dnd", HOUR);
      setOwnPresence("dnd");
      vi.advanceTimersByTime(3000);
      setOwnPresence("online"); // the straggler
      vi.advanceTimersByTime(2000);
      setOwnPresence("dnd"); // our frame finally landed
      vi.advanceTimersByTime(20_000);
      expect(loadStatusTimer()?.status).toBe("dnd");
      expect(loadUserStatus()).toBe("dnd");
      w.destroy();
    });

    it("ignores an echo of any recent status, not only the latest one left", () => {
      setOwnPresence("online");
      const w = startStatusTimerWatcher({ onRevert });
      saveUserStatus("idle");
      vi.advanceTimersByTime(1000);
      pickTimed("dnd", HOUR);
      setOwnPresence("dnd");
      setOwnPresence("online"); // two changes ago: still a straggler
      expect(loadStatusTimer()).not.toBeNull();
      expect(loadUserStatus()).toBe("dnd");
      w.destroy();
    });

    it("the recheck does not outlive the watcher", () => {
      setOwnPresence("online");
      const w = startStatusTimerWatcher({ onRevert });
      pickTimed("dnd", HOUR);
      setOwnPresence("dnd");
      setOwnPresence("online");
      w.destroy();
      vi.advanceTimersByTime(30_000);
      expect(loadStatusTimer()).not.toBeNull();
      expect(loadUserStatus()).toBe("dnd");
    });

    it("a live presence batched with other roster updates is still handled", () => {
      pickTimed("dnd", HOUR);
      const w = startStatusTimerWatcher({ onRevert });
      updatePresence(7, "idle");
      addMember({
        user: { id: 9, username: "bob", avatar: null, role: "member" },
        status: "online",
      } as never);
      membersStore.flush();
      expect(loadUserStatus()).toBe("idle");
      expect(loadStatusTimer()).toBeNull();
      w.destroy();
    });

    it("keeps the timer when the server echoes the timed status back", () => {
      setUser("online");
      pickTimed("dnd", HOUR);
      const w = startStatusTimerWatcher({ onRevert });
      setOwnPresence("dnd"); // our own optimistic apply and the echo
      setUser("dnd");
      expect(loadStatusTimer()).not.toBeNull();
      vi.advanceTimersByTime(HOUR);
      expect(onRevert).toHaveBeenCalledExactlyOnceWith("online");
      w.destroy();
    });

    it("does not read Offline (an invisible user, or a dropped socket) as a different choice", () => {
      pickTimed("invisible", HOUR);
      const w = startStatusTimerWatcher({ onRevert });
      setOwnPresence("offline");
      expect(loadStatusTimer()).not.toBeNull();
      vi.advanceTimersByTime(HOUR);
      expect(onRevert).toHaveBeenCalledExactlyOnceWith("online");
      w.destroy();
    });

    it("the firing never overrides a newer status the watcher was not told about", () => {
      pickTimed("dnd", HOUR);
      const w = startStatusTimerWatcher({ onRevert });
      // A newer choice written straight to storage (another window of an
      // older client), bypassing saveUserStatus and its timer cleanup.
      savePref("userStatus", "idle");
      vi.advanceTimersByTime(2 * HOUR);
      expect(onRevert).not.toHaveBeenCalled();
      expect(loadUserStatus()).toBe("idle");
      w.destroy();
    });
  });

  it("clearStatusTimer on nothing stores nothing", () => {
    const events = vi.fn();
    window.addEventListener("owncord:pref-change", events);
    clearStatusTimer();
    window.removeEventListener("owncord:pref-change", events);
    expect(events).not.toHaveBeenCalled();
  });
});

const at = (h: number, m = 0, s = 0): Date => new Date(2026, 9, 17, h, m, s);

describe("custom status Clear after", () => {
  it.each<[ClearAfterId, number | undefined]>([
    ["30m", 1800],
    ["1h", 3600],
    ["4h", 14400],
    ["never", undefined],
  ])("%s sends %s", (id, seconds) => {
    expect(clearAfterSeconds(id, at(10))).toBe(seconds);
  });

  it("Today is the seconds to local midnight", () => {
    expect(clearAfterSeconds("today", at(10))).toBe(14 * 3600);
    expect(clearAfterSeconds("today", at(23, 0, 0))).toBe(3600);
  });

  // Edge case (b): chosen half a minute before midnight, the server would
  // refuse a 30-second expiry, so it is raised to the 60-second minimum.
  it("Today chosen at 23:59:30 still sends at least 60 seconds", () => {
    expect(clearAfterSeconds("today", at(23, 59, 30))).toBe(60);
    expect(clearAfterSeconds("today", at(23, 59, 59))).toBe(60);
    expect(clearAfterSeconds("today", at(23, 58, 0))).toBe(120);
  });

  it("clamps into the server's 60..604800 range and whole seconds", () => {
    expect(clampExpiresIn(5)).toBe(60);
    expect(clampExpiresIn(1e9)).toBe(604_800);
    expect(clampExpiresIn(61.2)).toBe(62);
  });
});
