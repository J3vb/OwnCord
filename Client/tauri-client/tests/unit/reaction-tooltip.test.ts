/**
 * Who-reacted tooltip: the hover debounce, the per-message+emoji cache and its
 * invalidation, and the name formatting the tooltip renders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  REACTION_TOOLTIP_DEBOUNCE_MS,
  attachReactionTooltip,
  buildReactionTooltip,
  clearReactionUsersCache,
  formatReactorNames,
  getCachedReactionUsers,
  invalidateReactionUsers,
  loadReactionUsers,
  setReactionUsersFetcher,
} from "../../src/components/message-list/reaction-tooltip";
import type { ReactionUser } from "@lib/types";

function user(id: number, username: string): ReactionUser {
  return { id, username, avatar: "" };
}

const ALICE = user(1, "alice");
const BOB = user(2, "bob");

let fetcher: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearReactionUsersCache();
  fetcher = vi.fn().mockResolvedValue([ALICE, BOB]);
  setReactionUsersFetcher(fetcher as never);
});

afterEach(() => {
  setReactionUsersFetcher(null);
  vi.useRealTimers();
});

describe("formatReactorNames", () => {
  it("names a single reactor", () => {
    expect(formatReactorNames(["alice"])).toBe("alice");
  });

  it("joins two with 'and'", () => {
    expect(formatReactorNames(["alice", "bob"])).toBe("alice and bob");
  });

  it("joins three with commas and a final 'and'", () => {
    expect(formatReactorNames(["alice", "bob", "carol"])).toBe("alice, bob and carol");
  });

  it("collapses the tail into 'and N others'", () => {
    expect(formatReactorNames(["alice", "bob", "carol", "dave", "erin"])).toBe(
      "alice, bob, carol and 2 others",
    );
  });

  it("uses the singular for exactly one overflow name", () => {
    expect(formatReactorNames(["alice", "bob", "carol", "dave"])).toBe(
      "alice, bob, carol and 1 other",
    );
  });

  // The server caps the list at 100 but the pill's count can be higher; the
  // phrasing must follow the count, not the truncated list.
  it("counts overflow from the pill count, not the fetched list", () => {
    expect(formatReactorNames(["alice", "bob", "carol"], 250)).toBe(
      "alice, bob, carol and 247 others",
    );
  });

  it("returns an empty string for no reactors", () => {
    expect(formatReactorNames([])).toBe("");
  });
});

describe("buildReactionTooltip", () => {
  it("renders names and the emoji as text nodes", () => {
    const tip = buildReactionTooltip("👍", [ALICE, BOB], 2);
    expect(tip.querySelector(".reaction-tooltip-names")?.textContent).toBe("alice and bob");
    expect(tip.querySelector(".reaction-tooltip-emoji")?.textContent).toBe("reacted with 👍");
  });

  // Usernames are user-controlled: they must never be parsed as markup.
  it("escapes a username that looks like HTML", () => {
    const tip = buildReactionTooltip("👍", [user(9, "<img src=x onerror=alert(1)>")], 1);
    const names = tip.querySelector(".reaction-tooltip-names") as HTMLElement;
    expect(names.querySelector("img")).toBeNull();
    expect(names.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("loadReactionUsers — cache", () => {
  it("fetches once and serves later calls from the cache", async () => {
    await loadReactionUsers(5, 42, "👍");
    await loadReactionUsers(5, 42, "👍");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(5, 42, "👍");
    expect(getCachedReactionUsers(42, "👍")).toEqual([ALICE, BOB]);
  });

  it("keys the cache by emoji as well as message", async () => {
    await loadReactionUsers(5, 42, "👍");
    await loadReactionUsers(5, 42, "🎉");

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent requests for the same key", async () => {
    const [a, b] = await Promise.all([
      loadReactionUsers(5, 42, "👍"),
      loadReactionUsers(5, 42, "👍"),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("returns null and caches nothing when the request fails", async () => {
    fetcher.mockRejectedValue(new Error("403"));

    expect(await loadReactionUsers(5, 42, "👍")).toBeNull();
    expect(getCachedReactionUsers(42, "👍")).toBeUndefined();
  });

  it("returns null when no fetcher is registered", async () => {
    setReactionUsersFetcher(null);
    expect(await loadReactionUsers(5, 42, "👍")).toBeNull();
  });
});

describe("invalidateReactionUsers", () => {
  it("drops every emoji's list for the message", async () => {
    await loadReactionUsers(5, 42, "👍");
    await loadReactionUsers(5, 42, "🎉");

    invalidateReactionUsers(42);

    expect(getCachedReactionUsers(42, "👍")).toBeUndefined();
    expect(getCachedReactionUsers(42, "🎉")).toBeUndefined();

    await loadReactionUsers(5, 42, "👍");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("leaves other messages' caches alone", async () => {
    await loadReactionUsers(5, 42, "👍");
    await loadReactionUsers(5, 43, "👍");

    invalidateReactionUsers(42);

    expect(getCachedReactionUsers(43, "👍")).toEqual([ALICE, BOB]);
  });

  // Message ids share a prefix (42 / 420): the key separator must keep them apart.
  it("does not evict a message whose id merely starts with the same digits", async () => {
    await loadReactionUsers(5, 420, "👍");
    invalidateReactionUsers(42);
    expect(getCachedReactionUsers(420, "👍")).toEqual([ALICE, BOB]);
  });

  // A response that lands after an invalidation describes a state that already
  // changed — it must not repopulate the cache.
  it("discards an in-flight response that an invalidation raced", async () => {
    let resolve!: (users: readonly ReactionUser[]) => void;
    fetcher.mockReturnValue(
      new Promise<readonly ReactionUser[]>((r) => {
        resolve = r;
      }),
    );

    const pending = loadReactionUsers(5, 42, "👍");
    invalidateReactionUsers(42);
    resolve([ALICE]);
    await pending;

    expect(getCachedReactionUsers(42, "👍")).toBeUndefined();
  });

  it("clearReactionUsersCache drops everything", async () => {
    await loadReactionUsers(5, 42, "👍");
    clearReactionUsersCache();
    expect(getCachedReactionUsers(42, "👍")).toBeUndefined();
  });
});

describe("attachReactionTooltip", () => {
  function makeChip(): { chip: HTMLElement; ac: AbortController } {
    const chip = document.createElement("span");
    chip.className = "reaction-chip";
    document.body.appendChild(chip);
    return { chip, ac: new AbortController() };
  }

  beforeEach(() => {
    document.body.textContent = "";
  });

  it("does not fetch before the debounce elapses", () => {
    vi.useFakeTimers();
    const { chip, ac } = makeChip();
    attachReactionTooltip(chip, { channelId: 5, messageId: 42, emoji: "👍", count: 2 }, ac.signal);

    chip.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(REACTION_TOOLTIP_DEBOUNCE_MS - 1);

    expect(fetcher).not.toHaveBeenCalled();
    expect(chip.querySelector(".reaction-tooltip")).toBeNull();
  });

  it("shows the tooltip after the debounce elapses", async () => {
    const { chip, ac } = makeChip();
    attachReactionTooltip(chip, { channelId: 5, messageId: 42, emoji: "👍", count: 2 }, ac.signal);

    chip.dispatchEvent(new Event("mouseenter"));

    await vi.waitFor(() => {
      expect(chip.querySelector(".reaction-tooltip")).not.toBeNull();
    });
    expect(chip.querySelector(".reaction-tooltip-names")?.textContent).toBe("alice and bob");
    expect(fetcher).toHaveBeenCalledWith(5, 42, "👍");
  });

  it("cancels the pending fetch when the pointer leaves first", () => {
    vi.useFakeTimers();
    const { chip, ac } = makeChip();
    attachReactionTooltip(chip, { channelId: 5, messageId: 42, emoji: "👍", count: 2 }, ac.signal);

    chip.dispatchEvent(new Event("mouseenter"));
    chip.dispatchEvent(new Event("mouseleave"));
    vi.advanceTimersByTime(REACTION_TOOLTIP_DEBOUNCE_MS * 2);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("removes the tooltip on mouseleave", async () => {
    const { chip, ac } = makeChip();
    attachReactionTooltip(chip, { channelId: 5, messageId: 42, emoji: "👍", count: 2 }, ac.signal);

    chip.dispatchEvent(new Event("mouseenter"));
    await vi.waitFor(() => {
      expect(chip.querySelector(".reaction-tooltip")).not.toBeNull();
    });

    chip.dispatchEvent(new Event("mouseleave"));
    expect(chip.querySelector(".reaction-tooltip")).toBeNull();
  });

  it("does not pop a tooltip for a response that lands after the pointer left", async () => {
    let resolve!: (users: readonly ReactionUser[]) => void;
    fetcher.mockReturnValue(
      new Promise<readonly ReactionUser[]>((r) => {
        resolve = r;
      }),
    );

    const { chip, ac } = makeChip();
    attachReactionTooltip(chip, { channelId: 5, messageId: 42, emoji: "👍", count: 2 }, ac.signal);

    chip.dispatchEvent(new Event("mouseenter"));
    await vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalled();
    });
    chip.dispatchEvent(new Event("mouseleave"));
    resolve([ALICE]);
    await Promise.resolve();
    await Promise.resolve();

    expect(chip.querySelector(".reaction-tooltip")).toBeNull();
  });

  it("shows nothing when the reactor list comes back empty", async () => {
    fetcher.mockResolvedValue([]);
    const { chip, ac } = makeChip();
    attachReactionTooltip(chip, { channelId: 5, messageId: 42, emoji: "👍", count: 0 }, ac.signal);

    chip.dispatchEvent(new Event("mouseenter"));
    await vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalled();
    });
    await Promise.resolve();

    expect(chip.querySelector(".reaction-tooltip")).toBeNull();
  });

  it("mirrors hover on keyboard focus", async () => {
    const { chip, ac } = makeChip();
    attachReactionTooltip(chip, { channelId: 5, messageId: 42, emoji: "👍", count: 2 }, ac.signal);

    chip.dispatchEvent(new Event("focusin"));
    await vi.waitFor(() => {
      expect(chip.querySelector(".reaction-tooltip")).not.toBeNull();
    });

    chip.dispatchEvent(new Event("focusout"));
    expect(chip.querySelector(".reaction-tooltip")).toBeNull();
  });

  it("tears down the pending timer when the list is destroyed", () => {
    vi.useFakeTimers();
    const { chip, ac } = makeChip();
    attachReactionTooltip(chip, { channelId: 5, messageId: 42, emoji: "👍", count: 2 }, ac.signal);

    chip.dispatchEvent(new Event("mouseenter"));
    ac.abort();
    vi.advanceTimersByTime(REACTION_TOOLTIP_DEBOUNCE_MS * 2);

    expect(fetcher).not.toHaveBeenCalled();
  });

  // Regression: a full MessageList rebuild re-attaches every visible chip
  // against the same visit-long signal. A bare per-chip `abort` listener
  // never got removed, so every past rebuild's chips (and their detached
  // rows) stayed pinned in memory for the rest of the channel visit.
  it("registers only one abort listener per signal no matter how many chips attach", () => {
    const ac = new AbortController();
    const addEventListenerSpy = vi.spyOn(ac.signal, "addEventListener");

    // Simulate many rebuilds, each re-creating a fresh chip element and
    // re-attaching tooltip behaviour against the same long-lived signal.
    for (let i = 0; i < 50; i++) {
      const chip = document.createElement("span");
      document.body.appendChild(chip);
      attachReactionTooltip(
        chip,
        { channelId: 5, messageId: 42, emoji: "👍", count: 2 },
        ac.signal,
      );
    }

    const abortRegistrations = addEventListenerSpy.mock.calls.filter(([type]) => type === "abort");
    expect(abortRegistrations).toHaveLength(1);
  });

  it("hides every currently-hovering chip on a signal when it aborts, not just the first attached", () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const chipA = document.createElement("span");
    const chipB = document.createElement("span");
    document.body.append(chipA, chipB);
    attachReactionTooltip(chipA, { channelId: 5, messageId: 42, emoji: "👍", count: 2 }, ac.signal);
    attachReactionTooltip(chipB, { channelId: 5, messageId: 43, emoji: "🎉", count: 1 }, ac.signal);

    chipA.dispatchEvent(new Event("mouseenter"));
    chipB.dispatchEvent(new Event("mouseenter"));
    ac.abort();
    vi.advanceTimersByTime(REACTION_TOOLTIP_DEBOUNCE_MS * 2);

    expect(fetcher).not.toHaveBeenCalled();
  });
});
