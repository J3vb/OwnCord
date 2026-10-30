import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GROUP_THRESHOLD_MS,
  UNREAD_COUNT_CAP,
  atEachMidnight,
  formatBadgeCount,
  formatClockTime,
  formatDmRowTime,
  formatFullDate,
  formatMessageTimestamp,
  formatTime,
  getUserRole,
  isSameDay,
  parseTimestamp,
  resolveAuthor,
  roleColorVar,
  shouldGroup,
  userRoleColorVar,
} from "../../src/lib/text/formatting";
import { saveTimeFormat } from "../../src/lib/text/timeFormat";
import { savePref } from "../../src/lib/prefs/preferences";
import { resetChannelsStore, setRoles } from "../../src/stores/channels.store";
import { resetMembersStore, setMembers } from "../../src/stores/members.store";
import type { Message } from "../../src/stores/messages.store";
import type { ReadyMember, ReadyRole } from "../../src/lib/types";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key: "roleColors" } }));
  saveTimeFormat("12h");
  resetChannelsStore();
  resetMembersStore();
});

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): string =>
  new Date(y, mo - 1, d, h, mi, s, ms).toISOString();

/** The texts a Date is built from while `run` goes: a memo hit builds from a number instead. */
function textsParsed(run: () => void): string[] {
  const RealDate = Date;
  const texts: string[] = [];
  class CountingDate extends RealDate {
    constructor(value: string | number) {
      if (typeof value === "string") texts.push(value);
      super(value);
    }
  }
  vi.stubGlobal("Date", CountingDate);
  try {
    run();
  } finally {
    vi.unstubAllGlobals();
  }
  return texts;
}

const parsesFromText = (run: () => void): number => textsParsed(run).length;

const stamp = (i: number): string => new Date(Date.UTC(1990, 0, 1) + i * 1000).toISOString();

const base = (over: Partial<Message> = {}): Message => ({
  id: 1,
  channelId: 5,
  user: { id: 7, username: "ann", avatar: null },
  content: "hi",
  replyTo: null,
  attachments: [],
  reactions: [],
  pinned: false,
  editedAt: null,
  deleted: false,
  timestamp: "2026-03-19T08:00:00Z",
  status: "sent",
  correlationId: null,
  errorCode: null,
  ...over,
});
const at = (ms: number): string => new Date(Date.UTC(2026, 2, 19, 8, 0, 0) + ms).toISOString();

const member = (id: number, over: Partial<ReadyMember> = {}): ReadyMember => ({
  id,
  username: `user${String(id)}`,
  avatar: null,
  role: "member",
  status: "online",
  ...over,
});
const role = (id: number, name: string, over: Partial<ReadyRole> = {}): ReadyRole => ({
  id,
  name,
  color: null,
  permissions: 0,
  ...over,
});

describe("parseTimestamp", () => {
  it("reads a zone-less SQLite timestamp as UTC", () => {
    expect(parseTimestamp("2026-03-19 08:29:41").getTime()).toBe(Date.UTC(2026, 2, 19, 8, 29, 41));
  });

  it("reads a zone-less ISO timestamp as UTC", () => {
    expect(parseTimestamp("2026-03-19T08:29:41").getTime()).toBe(Date.UTC(2026, 2, 19, 8, 29, 41));
  });

  it("keeps an explicit Z or offset", () => {
    const utc = Date.UTC(2026, 2, 19, 8, 29, 41);
    expect(parseTimestamp("2026-03-19T08:29:41Z").getTime()).toBe(utc);
    expect(parseTimestamp("2026-03-19T10:29:41+02:00").getTime()).toBe(utc);
    expect(parseTimestamp("2026-03-19T03:29:41-05:00").getTime()).toBe(utc);
  });

  it("answers the same instant again, and an invalid date for garbage", () => {
    expect(parseTimestamp("2026-03-19 08:29:41").getTime()).toBe(
      parseTimestamp("2026-03-19 08:29:41").getTime(),
    );
    expect(Number.isNaN(parseTimestamp("not a time").getTime())).toBe(true);
    expect(Number.isNaN(parseTimestamp("not a time").getTime())).toBe(true);
  });

  it("hands out a fresh Date each call", () => {
    const first = parseTimestamp("2026-03-19T08:29:41Z");
    first.setFullYear(1999);
    expect(parseTimestamp("2026-03-19T08:29:41Z").getFullYear()).toBe(2026);
  });

  it("keeps answering correctly past the cache bound", () => {
    for (let i = 0; i < 2105; i++) {
      parseTimestamp(new Date(Date.UTC(2000, 0, 1) + i * 1000).toISOString());
    }
    expect(parseTimestamp("2026-03-19T08:29:41Z").getTime()).toBe(Date.UTC(2026, 2, 19, 8, 29, 41));
  });
});

describe("parseTimestamp zone handling", () => {
  it.each([
    ["1985-03-19 08:29:41", "1985-03-19T08:29:41Z"],
    ["1985-03-20T08:29:41", "1985-03-20T08:29:41Z"],
    ["1985-03-21T08:29:41Z", "1985-03-21T08:29:41Z"],
    ["1985-03-22T10:29:41+02:00", "1985-03-22T10:29:41+02:00"],
    ["1985-03-23T03:29:41-05:00", "1985-03-23T03:29:41-05:00"],
  ])("builds %s from %s, whatever zone the host is in", (raw, built) => {
    expect(textsParsed(() => parseTimestamp(raw))).toEqual([built]);
  });
});

describe("parseTimestamp memo", () => {
  it("parses a timestamp once and answers repeats from the memo", () => {
    const raw = "1991-03-19 08:29:41";
    expect(parsesFromText(() => parseTimestamp(raw))).toBe(1);
    expect(parsesFromText(() => parseTimestamp(raw))).toBe(0);
  });

  it("does not memoise a timestamp it cannot read", () => {
    expect(parsesFromText(() => parseTimestamp("not a time"))).toBe(1);
    expect(parsesFromText(() => parseTimestamp("not a time"))).toBe(1);
  });

  it("forgets the oldest timestamp only once 2000 are held, and keeps the rest", () => {
    // Fill the memo to its bound first, whatever earlier tests left in it.
    for (let i = 0; i < 2100; i++) parseTimestamp(stamp(i));
    const oldest = stamp(5000);
    parseTimestamp(oldest);
    expect(parsesFromText(() => parseTimestamp(oldest))).toBe(0);
    for (let i = 1; i < 2000; i++) parseTimestamp(stamp(5000 + i));
    // 2000 held, the oldest still among them.
    expect(parsesFromText(() => parseTimestamp(oldest))).toBe(0);
    parseTimestamp(stamp(7000));
    expect(parsesFromText(() => parseTimestamp(stamp(5000 + 1000)))).toBe(0);
    expect(parsesFromText(() => parseTimestamp(oldest))).toBe(1);
  });
});

describe("clock and date text", () => {
  it("writes a 24-hour HH:MM with zero padding", () => {
    expect(formatTime(local(2020, 1, 5, 3, 7))).toBe("03:07");
    expect(formatTime(local(2020, 1, 5, 18, 34))).toBe("18:34");
  });

  it("writes the long date", () => {
    expect(formatFullDate(local(2020, 6, 15, 12))).toBe("June 15, 2020");
  });

  it("writes the clock time on the chosen 12 or 24-hour clock", () => {
    expect(formatClockTime(local(2020, 6, 15, 18, 34))).toBe("6:34 PM");
    expect(formatClockTime(local(2020, 6, 15, 9, 5))).toBe("9:05 AM");
    saveTimeFormat("24h");
    expect(formatClockTime(local(2020, 6, 15, 18, 34))).toBe("18:34");
    expect(formatClockTime(local(2020, 6, 15, 9, 5))).toBe("09:05");
  });
});

describe("formatMessageTimestamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 0));
  });

  it("says Today for any time from midnight on", () => {
    expect(formatMessageTimestamp(local(2026, 10, 15, 9, 5))).toBe("Today at 9:05 AM");
    expect(formatMessageTimestamp(local(2026, 10, 15, 0, 0, 0, 0))).toBe("Today at 12:00 AM");
  });

  it("says Yesterday for the whole previous calendar day", () => {
    expect(formatMessageTimestamp(local(2026, 10, 14, 23, 59, 59, 999))).toBe(
      "Yesterday at 11:59 PM",
    );
    expect(formatMessageTimestamp(local(2026, 10, 14, 0, 0, 0, 0))).toBe("Yesterday at 12:00 AM");
  });

  it("writes MM/DD/YYYY and the time for anything older", () => {
    expect(formatMessageTimestamp(local(2026, 10, 13, 23, 59, 59, 999))).toBe(
      "10/13/2026 11:59 PM",
    );
    expect(formatMessageTimestamp(local(2020, 1, 5, 18, 34))).toBe("01/05/2020 6:34 PM");
    expect(formatMessageTimestamp(local(2019, 12, 25, 8, 0))).toBe("12/25/2019 8:00 AM");
  });

  it("follows the 24-hour clock", () => {
    saveTimeFormat("24h");
    expect(formatMessageTimestamp(local(2026, 10, 15, 18, 34))).toBe("Today at 18:34");
    expect(formatMessageTimestamp(local(2020, 1, 5, 18, 34))).toBe("01/05/2020 18:34");
  });

  it("finds yesterday across a month boundary", () => {
    vi.setSystemTime(new Date(2026, 10, 1, 8, 0, 0));
    expect(formatMessageTimestamp(local(2026, 10, 31, 20, 0))).toBe("Yesterday at 8:00 PM");
  });
});

describe("formatDmRowTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 0));
  });

  it("stays empty for no time", () => {
    expect(formatDmRowTime("")).toBe("");
  });

  it("shows the clock time for today, from midnight on", () => {
    expect(formatDmRowTime(local(2026, 10, 15, 15, 4))).toBe("3:04 PM");
    expect(formatDmRowTime(local(2026, 10, 15, 0, 0, 0, 0))).toBe("12:00 AM");
    saveTimeFormat("24h");
    expect(formatDmRowTime(local(2026, 10, 15, 15, 4))).toBe("15:04");
  });

  it("shows a short date for an earlier day this year", () => {
    expect(formatDmRowTime(local(2026, 10, 14, 23, 59, 59, 999))).toBe("Oct 14");
    expect(formatDmRowTime(local(2026, 1, 2, 10))).toBe("Jan 2");
  });

  it("adds the year for an earlier year", () => {
    expect(formatDmRowTime(local(2025, 9, 29, 10))).toBe("Sep 29, 2025");
  });
});

describe("atEachMidnight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15, 22, 0, 0));
  });

  it("runs at each local midnight until the signal aborts", () => {
    const ac = new AbortController();
    const fn = vi.fn();
    atEachMidnight(ac.signal, fn);

    vi.advanceTimersByTime(2 * 3600_000 - 1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(24 * 3600_000 - 1);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(2);

    ac.abort();
    vi.advanceTimersByTime(3 * 24 * 3600_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("never runs for a signal that is already aborted", () => {
    const ac = new AbortController();
    ac.abort();
    const fn = vi.fn();
    atEachMidnight(ac.signal, fn);
    vi.advanceTimersByTime(48 * 3600_000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("formatBadgeCount", () => {
  it("shows the number below the wire cap and 99+ from it", () => {
    expect(UNREAD_COUNT_CAP).toBe(100);
    expect(formatBadgeCount(0)).toBe("0");
    expect(formatBadgeCount(1)).toBe("1");
    expect(formatBadgeCount(99)).toBe("99");
    expect(formatBadgeCount(100)).toBe("99+");
    expect(formatBadgeCount(4321)).toBe("99+");
  });
});

describe("isSameDay", () => {
  it("is true for two times on one local day", () => {
    expect(isSameDay(local(2020, 6, 15, 0, 0), local(2020, 6, 15, 23, 59))).toBe(true);
  });

  it("is false when only the day, month or year differs", () => {
    expect(isSameDay(local(2020, 6, 15, 12), local(2020, 6, 16, 12))).toBe(false);
    expect(isSameDay(local(2020, 6, 15, 12), local(2020, 7, 15, 12))).toBe(false);
    expect(isSameDay(local(2020, 6, 15, 12), local(2021, 6, 15, 12))).toBe(false);
  });
});

describe("shouldGroup", () => {
  it("groups the same author inside the threshold and not at it", () => {
    expect(GROUP_THRESHOLD_MS).toBe(7 * 60 * 1000);
    const prev = base();
    expect(shouldGroup(prev, base({ timestamp: at(GROUP_THRESHOLD_MS - 1) }))).toBe(true);
    expect(shouldGroup(prev, base({ timestamp: at(GROUP_THRESHOLD_MS) }))).toBe(false);
    expect(shouldGroup(prev, base({ timestamp: at(GROUP_THRESHOLD_MS + 1) }))).toBe(false);
  });

  it("does not group different authors", () => {
    expect(
      shouldGroup(
        base(),
        base({ user: { id: 8, username: "bob", avatar: null }, timestamp: at(1) }),
      ),
    ).toBe(false);
  });

  it("does not group a deleted message on either side", () => {
    expect(shouldGroup(base({ deleted: true }), base({ timestamp: at(1) }))).toBe(false);
    expect(shouldGroup(base(), base({ deleted: true, timestamp: at(1) }))).toBe(false);
  });

  it("starts a new block for a reply", () => {
    expect(shouldGroup(base(), base({ replyTo: 1, timestamp: at(1) }))).toBe(false);
  });

  it("keeps server rows on their own", () => {
    expect(shouldGroup(base({ kind: "call" }), base({ timestamp: at(1) }))).toBe(false);
    expect(shouldGroup(base(), base({ kind: "call", timestamp: at(1) }))).toBe(false);
    expect(shouldGroup(base({ kind: "" }), base({ kind: "", timestamp: at(1) }))).toBe(true);
  });
});

describe("roles and authors", () => {
  it("names a member's role, member by default", () => {
    setMembers([member(1, { role: "admin" })]);
    expect(getUserRole(1)).toBe("admin");
    expect(getUserRole(99)).toBe("member");
  });

  it("colours a role from the server's colour, matching names without case", () => {
    setRoles([role(1, "Admin", { color: "#ff0000" })]);
    expect(roleColorVar("admin")).toBe("#ff0000");
    expect(roleColorVar("ADMIN")).toBe("#ff0000");
  });

  it("falls back to the theme variables when a role has no colour", () => {
    setRoles([role(1, "admin", { color: "" }), role(2, "moderator", { color: null })]);
    expect(roleColorVar("owner")).toBe("var(--role-owner)");
    expect(roleColorVar("admin")).toBe("var(--role-admin)");
    expect(roleColorVar("moderator")).toBe("var(--role-mod)");
    expect(roleColorVar("member")).toBe("var(--role-member)");
    expect(roleColorVar("custom")).toBe("var(--role-member)");
  });

  it("goes back to coloured roles when the preference is cleared", () => {
    setRoles([role(1, "admin", { color: "#ff0000" })]);
    savePref("roleColors", false);
    expect(roleColorVar("admin")).toBe("var(--role-member)");
    localStorage.removeItem("owncord:settings:roleColors");
    window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key: "roleColors" } }));
    expect(roleColorVar("admin")).toBe("#ff0000");
  });

  it("ignores a role whose name differs, whatever its colour", () => {
    setRoles([role(1, "Mod", { color: "#123456" }), role(2, "", { color: "#abcdef" })]);
    expect(roleColorVar("admin")).toBe("var(--role-admin)");
    expect(userRoleColorVar(99)).toBe("var(--role-member)");
  });

  it("uses the plain member colour for every role while role colours are off", () => {
    setRoles([role(1, "admin", { color: "#ff0000" })]);
    savePref("roleColors", false);
    expect(roleColorVar("admin")).toBe("var(--role-member)");
    expect(roleColorVar("owner")).toBe("var(--role-member)");
    savePref("roleColors", true);
    expect(roleColorVar("admin")).toBe("#ff0000");
  });

  it("colours a member by the highest-position coloured role they hold", () => {
    setRoles([
      role(1, "low", { color: "#111111", position: 1 }),
      role(2, "high", { color: "#222222", position: 5 }),
      role(3, "plain", { color: "", position: 9 }),
      role(4, "none", { color: null, position: 9 }),
      role(5, "unheld", { color: "#555555", position: 20 }),
    ]);
    setMembers([member(1, { role: "member", role_ids: [1, 2, 3, 4] })]);
    expect(userRoleColorVar(1)).toBe("#222222");
  });

  it("keeps the first of two coloured roles at one position, and treats a missing position as 0", () => {
    setRoles([
      role(1, "first", { color: "#111111", position: 3 }),
      role(2, "second", { color: "#222222", position: 3 }),
    ]);
    setMembers([member(1, { role_ids: [1, 2] })]);
    expect(userRoleColorVar(1)).toBe("#111111");

    setRoles([
      role(1, "unranked", { color: "#111111" }),
      role(2, "ranked", { color: "#222222", position: 1 }),
    ]);
    expect(userRoleColorVar(1)).toBe("#222222");
    setRoles([role(1, "unranked", { color: "#111111" }), role(2, "other", { color: "#222222" })]);
    expect(userRoleColorVar(1)).toBe("#111111");
  });

  it("uses the single role's colour for one role id, none, or no coloured role", () => {
    setRoles([
      role(1, "member", { color: "#aaaaaa", position: 1 }),
      role(2, "extra", { color: "#bbbbbb", position: 5 }),
      role(3, "bare", { color: null, position: 7 }),
    ]);
    setMembers([
      member(1, { role: "member", role_ids: [2] }),
      member(2, { role: "member" }),
      member(3, { role: "member", role_ids: [3, 3] }),
    ]);
    expect(userRoleColorVar(1)).toBe("#aaaaaa");
    expect(userRoleColorVar(2)).toBe("#aaaaaa");
    expect(userRoleColorVar(3)).toBe("#aaaaaa");
    expect(userRoleColorVar(99)).toBe("#aaaaaa");
  });

  it("ignores role ids while role colours are off", () => {
    setRoles([
      role(1, "a", { color: "#111111", position: 1 }),
      role(2, "b", { color: "#222222", position: 2 }),
    ]);
    setMembers([member(1, { role_ids: [1, 2] })]);
    savePref("roleColors", false);
    expect(userRoleColorVar(1)).toBe("var(--role-member)");
  });

  it("resolves an author from the member store first and the message second", () => {
    setMembers([member(1, { username: "live", avatar: "a.png", display_name: "Live Name" })]);
    const payload = { id: 1, username: "old", avatar: "old.png", display_name: "Old Name" };
    expect(resolveAuthor(payload)).toEqual({
      username: "live",
      displayName: "Live Name",
      avatar: "a.png",
    });
    setMembers([member(1, { username: "live", avatar: null })]);
    expect(resolveAuthor(payload)).toEqual({
      username: "live",
      displayName: null,
      avatar: null,
    });
    expect(
      resolveAuthor({ id: 2, username: "gone", avatar: "g.png", display_name: "Gone" }),
    ).toEqual({
      username: "gone",
      displayName: "Gone",
      avatar: "g.png",
    });
    expect(resolveAuthor({ id: 2, username: "gone", avatar: null })).toEqual({
      username: "gone",
      displayName: null,
      avatar: null,
    });
  });
});
