import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "../../helpers/memberListMocks";
import { createMemberList } from "@components/MemberList";
import type { MemberListOptions } from "@components/MemberList";
import {
  membersStore,
  updatePresence,
  updateMemberRole,
  updateMemberProfile,
} from "@stores/members.store";
import type { Member } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { setConnectionStatus } from "@stores/ui.store";
import { type UserStatus } from "../../../src/lib/types";
import { openUserProfilePopup } from "../../../src/features/profiles/openUserProfilePopup";
import "@components/UserProfilePopup";
import "@components/AdminActions";
import {
  resetStore,
  makeMember,
  setTestMembers,
  defaultOpts,
  openProfileOf,
  useMemberListSuite,
} from "../../helpers/memberListHarness";

// ─── Phase 6: display names, custom status, invisible ────────────────────────

describe("MemberList profile fields", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMemberList> | null = null;

  const opts: MemberListOptions = {
    currentUserRole: "member",
    onKick: vi.fn(),
    onBan: vi.fn(),
    onChangeRole: vi.fn(),
    onToggleBlock: vi.fn(),
  };

  function mountMembers(members: Member[]): void {
    setTestMembers(members);
    list = createMemberList(opts);
    list.mount(container);
  }

  beforeEach(() => {
    resetStore();
    // The popup's Message/Call are disabled while offline (WP 3B-2).
    setConnectionStatus("connected");
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    list?.destroy?.();
    list = null;
    container.remove();
    resetStore();
    setConnectionStatus("disconnected");
  });

  it("renders the display name and falls back to the username", () => {
    mountMembers([
      makeMember({ id: 1, username: "alice", displayName: "Alice A." }),
      makeMember({ id: 2, username: "bob", displayName: null }),
    ]);

    const names = Array.from(container.querySelectorAll(".mi-name")).map((el) => el.textContent);
    expect(names).toContain("Alice A.");
    expect(names).toContain("bob");
    // The username is not shown twice — the display name replaces it here.
    expect(names).not.toContain("alice");
  });

  it("shows a custom status under the name, and omits the line without one", () => {
    mountMembers([
      makeMember({ id: 1, username: "alice", customStatus: "shipping phase 6" }),
      makeMember({ id: 2, username: "bob" }),
    ]);

    const withStatus = container.querySelector('[data-testid="member-custom-status-1"]');
    expect(withStatus?.textContent).toBe("shipping phase 6");
    expect(container.querySelector('[data-testid="member-custom-status-2"]')).toBeNull();
  });

  it("shows Playing <game> as the second line, with the controller icon", () => {
    mountMembers([
      makeMember({
        id: 1,
        username: "alice",
        activity: { name: "VALORANT", startedAt: Date.now() - 60_000 },
      }),
      makeMember({ id: 2, username: "bob" }),
    ]);

    const line = container.querySelector('[data-testid="member-activity-1"]');
    expect(line?.textContent).toBe("Playing VALORANT");
    expect(line?.querySelector("svg")).not.toBeNull();
    expect(container.querySelector('[data-testid="member-activity-2"]')).toBeNull();
    // The row is described by the game line as well as the status dot.
    const row = container.querySelector('[data-testid="member-1"]');
    expect(row?.getAttribute("aria-describedby")).toContain("mi-activity-1");
  });

  it("lets a custom status win the row; the game is not drawn there", () => {
    mountMembers([
      makeMember({
        id: 1,
        username: "alice",
        customStatus: "shipping phase 6",
        activity: { name: "VALORANT", startedAt: Date.now() },
      }),
    ]);

    expect(container.querySelector('[data-testid="member-custom-status-1"]')?.textContent).toBe(
      "shipping phase 6",
    );
    expect(container.querySelector('[data-testid="member-activity-1"]')).toBeNull();
  });

  it("follows a game starting and stopping in place", () => {
    mountMembers([makeMember({ id: 1, username: "alice" })]);
    expect(container.querySelector('[data-testid="member-activity-1"]')).toBeNull();

    setTestMembers([
      makeMember({ id: 1, username: "alice", activity: { name: "Factorio", startedAt: 1 } }),
    ]);
    membersStore.flush();
    expect(container.querySelector('[data-testid="member-activity-1"]')?.textContent).toBe(
      "Playing Factorio",
    );

    setTestMembers([makeMember({ id: 1, username: "alice", activity: null })]);
    membersStore.flush();
    expect(container.querySelector('[data-testid="member-activity-1"]')).toBeNull();
  });

  describe("Listening to <player>", () => {
    const song = {
      title: "Blue in Green",
      artist: "Miles Davis",
      player: "Spotify",
      startedAt: 1,
      durationMs: 337_000,
    };

    it("shows Listening to <player> as the second line, with the music note", () => {
      mountMembers([
        makeMember({ id: 1, username: "alice", listening: song }),
        makeMember({ id: 2, username: "bob" }),
      ]);

      const line = container.querySelector('[data-testid="member-activity-1"]');
      expect(line?.textContent).toBe("Listening to Spotify");
      expect(line?.querySelector("svg")).not.toBeNull();
      expect(line?.querySelector("svg path")?.getAttribute("d")).toBe("M9 18V5l12-2v13");
      expect(container.querySelector('[data-testid="member-activity-2"]')).toBeNull();
      const row = container.querySelector('[data-testid="member-1"]');
      expect(row?.getAttribute("aria-describedby")).toContain("mi-activity-1");
    });

    it("priority: a custom status beats a game, and a game beats music", () => {
      const activity = { name: "VALORANT", startedAt: Date.now() };
      mountMembers([
        makeMember({ id: 1, username: "alice", customStatus: "busy", activity, listening: song }),
        makeMember({ id: 2, username: "bob", activity, listening: song }),
        makeMember({ id: 3, username: "cy", listening: song }),
      ]);

      expect(container.querySelector('[data-testid="member-custom-status-1"]')?.textContent).toBe(
        "busy",
      );
      expect(container.querySelector('[data-testid="member-activity-1"]')).toBeNull();
      expect(container.querySelector('[data-testid="member-activity-2"]')?.textContent).toBe(
        "Playing VALORANT",
      );
      expect(container.querySelector('[data-testid="member-activity-3"]')?.textContent).toBe(
        "Listening to Spotify",
      );
    });

    it("follows a song starting, the game taking over, and the music stopping in place", () => {
      mountMembers([makeMember({ id: 1, username: "alice" })]);
      expect(container.querySelector('[data-testid="member-activity-1"]')).toBeNull();

      setTestMembers([makeMember({ id: 1, username: "alice", listening: song })]);
      membersStore.flush();
      expect(container.querySelector('[data-testid="member-activity-1"]')?.textContent).toBe(
        "Listening to Spotify",
      );

      setTestMembers([
        makeMember({
          id: 1,
          username: "alice",
          listening: song,
          activity: { name: "Factorio", startedAt: 1 },
        }),
      ]);
      membersStore.flush();
      const game = container.querySelector('[data-testid="member-activity-1"]');
      expect(game?.textContent).toBe("Playing Factorio");
      // The icon changed with the line: the controller, not the note.
      expect(game?.querySelector("svg path")?.getAttribute("d")).not.toBe("M9 18V5l12-2v13");

      setTestMembers([makeMember({ id: 1, username: "alice", listening: null, activity: null })]);
      membersStore.flush();
      expect(container.querySelector('[data-testid="member-activity-1"]')).toBeNull();
    });
  });

  it("opens the profile from the keyboard, where Report names the user", async () => {
    setTestMembers([
      makeMember({ id: 1, username: "alice", displayName: "Alice A." }),
      makeMember({ id: 2, username: "me" }),
    ]);
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 2, username: "me", avatar: null, role: "member" },
    }));
    const onReportUser = vi.fn();
    list = createMemberList({ ...opts, onReportUser });
    list.mount(container);

    const row = container.querySelector<HTMLElement>('[data-testid="member-1"]')!;
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.getAttribute("aria-label")).toBe("Alice A.");
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const report = await vi.waitFor(() => {
      const btn = document.querySelector<HTMLButtonElement>('[data-testid="upp-report-btn"]');
      expect(btn).not.toBeNull();
      return btn!;
    });
    report.click();
    expect(onReportUser).toHaveBeenCalledWith(1, "Alice A.");

    // Your own profile has nothing to report.
    const self = container.querySelector<HTMLElement>('[data-testid="member-2"]')!;
    self.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="user-profile-popup"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-testid="upp-report-btn"]')).toBeNull();
  });

  it("wires the profile popup's Call action to onCallUser, but not for yourself", async () => {
    setTestMembers([
      makeMember({ id: 1, username: "alice" }),
      makeMember({ id: 2, username: "me" }),
    ]);
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 2, username: "me", avatar: null, role: "member" },
    }));
    const onCallUser = vi.fn();
    list = createMemberList({ ...opts, onCallUser });
    list.mount(container);

    // Another member: the Call action renders and reaches the handler.
    const other = container.querySelector<HTMLElement>('[data-testid="member-1"]')!;
    other.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    const callBtn = await vi.waitFor(() => {
      const btn = document.querySelector<HTMLButtonElement>('[data-testid="upp-call-btn"]');
      expect(btn).not.toBeNull();
      return btn!;
    });
    callBtn.click();
    expect(onCallUser).toHaveBeenCalledWith(1);
    // Clicking an action closes the popup, like Message does.
    expect(document.querySelector('[data-testid="user-profile-popup"]')).toBeNull();

    // Your own profile has no Call action — you are already in the call.
    await openProfileOf(container, 2);
    expect(document.querySelector('[data-testid="upp-call-btn"]')).toBeNull();
  });

  it("omits the Call action when no onCallUser handler is wired", async () => {
    mountMembers([makeMember({ id: 1, username: "alice" })]);

    await openProfileOf(container, 1);
    expect(document.querySelector('[data-testid="upp-call-btn"]')).toBeNull();
  });

  it("returns focus to the row that opened the profile after an earlier one closed", async () => {
    mountMembers([
      makeMember({ id: 1, username: "alice" }),
      makeMember({ id: 3, username: "carol" }),
    ]);
    const rowA = container.querySelector<HTMLElement>('[data-testid="member-1"]')!;
    const rowB = container.querySelector<HTMLElement>('[data-testid="member-3"]')!;
    const openFrom = async (row: HTMLElement): Promise<void> => {
      row.focus();
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await vi.waitFor(() =>
        expect(document.activeElement?.getAttribute("data-testid")).toBe("user-profile-popup"),
      );
    };
    const escape = (): void => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    };

    await openFrom(rowA);
    escape();
    expect(document.activeElement).toBe(rowA);

    await openFrom(rowB);
    escape();
    expect(document.activeElement).toBe(rowB);
  });

  it("returns focus to the user's rebuilt row when the list re-rendered while the profile was open", async () => {
    mountMembers([
      makeMember({ id: 1, username: "alice" }),
      makeMember({ id: 3, username: "carol" }),
    ]);
    const before = container.querySelector<HTMLElement>('[data-testid="member-3"]')!;
    before.focus();
    before.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute("data-testid")).toBe("user-profile-popup"),
    );

    updateMemberRole(3, "admin");
    membersStore.flush();
    const after = container.querySelector<HTMLElement>('[data-testid="member-3"]')!;
    expect(after).not.toBe(before);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.activeElement).toBe(after);
  });

  it("leaves a profile popup another component opened open when it is destroyed", async () => {
    mountMembers([makeMember({ id: 1, username: "alice" })]);

    // A message author card, opened by MessageList through the shared opener.
    const closeOther = openUserProfilePopup({ userId: 1, anchorX: 0, anchorY: 0 });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="user-profile-popup"]')).not.toBeNull(),
    );

    list!.destroy?.();
    list = undefined as never;

    expect(document.querySelector('[data-testid="user-profile-popup"]')).not.toBeNull();
    closeOther();
  });

  it("closes the profile popup it opened itself when it is destroyed", async () => {
    mountMembers([makeMember({ id: 1, username: "alice" })]);
    container
      .querySelector<HTMLElement>('[data-testid="member-1"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="user-profile-popup"]')).not.toBeNull(),
    );

    list!.destroy?.();
    list = undefined as never;

    expect(document.querySelector('[data-testid="user-profile-popup"]')).toBeNull();
  });

  it("describes each row by its custom status and presence, kept current", () => {
    mountMembers([
      makeMember({ id: 1, username: "alice", customStatus: "shipping" }),
      makeMember({ id: 2, username: "bob", status: "idle" }),
    ]);

    const description = (testId: string): string =>
      container
        .querySelector(`[data-testid="${testId}"]`)!
        .getAttribute("aria-describedby")!
        .split(" ")
        .map((id) => {
          const el = document.getElementById(id)!;
          return el.getAttribute("aria-label") ?? el.textContent;
        })
        .join(" ");
    expect(description("member-1")).toBe("shipping Online");
    expect(description("member-2")).toBe("Idle");

    updatePresence(1, "dnd");
    membersStore.flush();
    expect(description("member-1")).toBe("shipping Do Not Disturb");
  });

  it("renders an invisible member the way it renders an offline one", () => {
    // Only ever the signed-in user's own row — everyone else is mapped to
    // offline server-side — but it has to look like what others see.
    mountMembers([makeMember({ id: 1, username: "ghost", status: "invisible" as UserStatus })]);

    const row = container.querySelector('[data-testid="member-1"]');
    expect(row?.classList.contains("offline")).toBe(true);
  });

  it("re-renders (not just recolors) when a custom status changes", () => {
    mountMembers([makeMember({ id: 1, username: "alice" })]);
    expect(container.querySelector('[data-testid="member-custom-status-1"]')).toBeNull();

    updatePresence(1, "online", "back in 5");
    membersStore.flush();
    // A custom status is its own line, so it needs a structural render — the
    // presence-only fast path would have left the row without it.
    expect(container.querySelector('[data-testid="member-custom-status-1"]')?.textContent).toBe(
      "back in 5",
    );
  });
});

describe("MemberList search (3C-4b)", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMemberList> | null = null;

  const row = (id: number): HTMLElement =>
    container.querySelector<HTMLElement>(`[data-testid="member-${id}"]`)!;
  const box = (): HTMLInputElement =>
    container.querySelector<HTMLInputElement>('[data-testid="member-search"]')!;
  const texts = (): string[] =>
    Array.from(
      container.querySelectorAll(".member-role-group, .member-item, .member-list-empty-text"),
    ).map((el) =>
      el.classList.contains("member-item")
        ? (el.getAttribute("data-testid") ?? "")
        : (el.textContent ?? ""),
    );
  function type(value: string): void {
    box().value = value;
    box().dispatchEvent(new Event("input", { bubbles: true }));
  }

  useMemberListSuite(
    (c) => {
      container = c;
      list = null;
    },
    () => list,
  );

  function mountWith(members: Member[]): void {
    setTestMembers(members);
    list = createMemberList(defaultOpts());
    list.mount(container);
  }

  const roster = (): Member[] => [
    makeMember({ id: 1, username: "zoe_x", displayName: "Zoë Quinn", role: "admin" }),
    makeMember({ id: 2, username: "bob", role: "member" }),
    makeMember({ id: 3, username: "zorro", role: "member", status: "offline" }),
    makeMember({ id: 4, username: "carl", displayName: "Carlos", role: "member" }),
  ];

  it("renders a labelled search box before the list", () => {
    mountWith(roster());
    expect(box().getAttribute("aria-label")).toBe("Search members");
    expect(box().placeholder).toBe("Search members");
    expect(box().parentElement!.nextElementSibling!.classList.contains("member-list")).toBe(true);
    list!.destroy?.();
    expect(container.querySelector(".member-search-wrap")).toBeNull();
  });

  it("search filters by display name and username, case- and diacritic-insensitive", () => {
    mountWith(roster());
    type("ZOE");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-1"]);
    type("ZO");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-1", "member-3"]);
    type("quinn");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-1"]);
    type("carlos");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-4"]);
    type("CARL");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-4"]);
  });

  it("search ignores a leading @ and surrounding spaces", () => {
    mountWith(roster());
    type("  @bob ");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-2"]);
    type("@ bob");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-2"]);
  });

  it("search re-folds a member renamed while filtered", () => {
    mountWith(roster());
    type("quinn");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-1"]);
    updateMemberProfile(1, { username: "zoe_x", avatar: null, displayName: "Zed" });
    membersStore.flush();
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual([]);
    type("zed");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-1"]);
  });

  it("counts reflect matches and empty groups hide", () => {
    mountWith(roster());
    expect(texts().filter((t) => t.includes(" — "))).toEqual([
      "ADMIN — 1",
      "MEMBER — 2",
      "OFFLINE — 1",
    ]);
    type("zo");
    expect(texts()).toEqual(["ADMIN — 1", "member-1", "OFFLINE — 1", "member-3"]);
    type("bob");
    expect(texts()).toEqual(["MEMBER — 1", "member-2"]);
  });

  it("no match shows members.searchEmpty, and clearing restores the list", () => {
    mountWith(roster());
    type("nobody");
    expect(texts()).toEqual(["No members match your search"]);
    type("");
    expect(texts().filter((t) => t.startsWith("member-"))).toHaveLength(4);
  });

  it("Escape clears a non-empty query and keeps focus; an empty box is left alone", () => {
    mountWith(roster());
    box().focus();
    type("bob");
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    box().dispatchEvent(esc);
    document.removeEventListener("keydown", seen);
    expect(box().value).toBe("");
    expect(esc.defaultPrevented).toBe(true);
    expect(seen).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(box());
    expect(texts().filter((t) => t.startsWith("member-"))).toHaveLength(4);

    const again = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    box().dispatchEvent(again);
    expect(again.defaultPrevented).toBe(false);
  });

  it("a live presence change keeps the filter applied", () => {
    mountWith(roster());
    type("zo");
    updatePresence(1, "offline");
    membersStore.flush();
    expect(texts()).toEqual(["OFFLINE — 2", "member-1", "member-3"]);
    // A member who joins and does not match stays hidden; one who does shows.
    setTestMembers([
      ...roster(),
      makeMember({ id: 9, username: "newbie" }),
      makeMember({ id: 10, username: "zoomer" }),
    ]);
    membersStore.flush();
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual([
      "member-1",
      "member-10",
      "member-3",
    ]);
  });

  it("a full snapshot re-applies the active search and reuses unchanged rows", () => {
    mountWith(roster());
    type("zo");
    const before = row(1);
    setTestMembers(roster().map((m) => ({ ...m })));
    membersStore.flush();
    expect(box().value).toBe("zo");
    expect(texts().filter((t) => t.startsWith("member-"))).toEqual(["member-1", "member-3"]);
    expect(row(1)).toBe(before);
    expect(texts().filter((t) => t.includes(" — "))).toEqual(["ADMIN — 1", "OFFLINE — 1"]);
  });
});
