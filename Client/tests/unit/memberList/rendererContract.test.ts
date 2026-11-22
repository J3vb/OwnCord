import { describe, it, expect } from "vitest";
import "../../helpers/memberListMocks";
import { createMemberList } from "../../../src/features/members/MemberList";
import { classicMemberRows } from "../../../src/features/members/memberRowRenderer";
import type { MemberRowRenderer } from "../../../src/features/members/memberRowRenderer";
import type { ListItem } from "../../../src/features/members/memberModel";
import { membersStore, updatePresence } from "@stores/members.store";
import type { Member } from "@stores/members.store";
import "../../../src/features/profiles/userProfilePopup";
import "../../../src/features/moderation/AdminActions";
import {
  makeMember,
  setTestMembers,
  defaultOpts,
  useMemberListSuite,
  rightClickMember,
} from "../../helpers/memberListHarness";

const MEMBER_ROW_RENDERERS = [["classic", classicMemberRows]] as const;

describe.each(MEMBER_ROW_RENDERERS)("member row renderer: %s", (_name, rows: MemberRowRenderer) => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMemberList> | null;

  const row = (id: number): HTMLElement =>
    container.querySelector<HTMLElement>(`[data-testid="member-${id}"]`)!;
  const press = (el: Element, key: string): void => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  };
  const focusedId = (): string | null | undefined =>
    document.activeElement?.getAttribute("data-testid");

  // ADMIN: ann(1); MEMBER: bob(2), cy(3); OFFLINE: dee(4), eli(5).
  const roster = (): Member[] => [
    makeMember({ id: 1, username: "ann", role: "admin" }),
    makeMember({ id: 2, username: "bob", role: "member" }),
    makeMember({ id: 3, username: "cy", role: "member" }),
    makeMember({ id: 4, username: "dee", role: "member", status: "offline" }),
    makeMember({ id: 5, username: "eli", role: "member", status: "offline" }),
  ];

  function mountWith(members: Member[]): void {
    setTestMembers(members);
    list = createMemberList({ ...defaultOpts(), rows });
    list.mount(container);
  }

  useMemberListSuite(
    (c) => {
      container = c;
      list = null;
    },
    () => list,
  );

  it("one focusable, named row per member with its testid and class", () => {
    mountWith(roster());
    const rowEls = container.querySelectorAll(".member-item");
    expect(rowEls).toHaveLength(5);
    for (const id of [1, 2, 3, 4, 5]) {
      const el = row(id);
      expect(el.classList.contains("member-item")).toBe(true);
      expect(el.getAttribute("role")).toBe("button");
      expect(el.getAttribute("tabindex")).toBe("0");
      expect(el.getAttribute("aria-label") ?? el.textContent ?? "").not.toBe("");
    }
  });

  it("a presence change patches the row in place", () => {
    mountWith(roster());
    const before = row(2);
    updatePresence(2, "dnd");
    membersStore.flush();
    expect(row(2)).toBe(before);
    expect(before.querySelector(".mi-status")?.getAttribute("aria-label")).toBe("Do Not Disturb");
  });

  it("a rename rebuilds the row and aborts the old row's listeners", () => {
    const members = roster();
    mountWith(members);
    const old = row(2);
    setTestMembers(members.map((m) => (m.id === 2 ? { ...m, displayName: "Bobby" } : m)));
    membersStore.flush();
    expect(row(2)).not.toBe(old);
    old.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    expect(document.querySelector('[data-testid="user-profile-popup"]')).toBeNull();
  });

  it("arrows, Home and End move between rows and skip headers", () => {
    mountWith(roster());
    row(1).focus();
    press(row(1), "ArrowDown");
    expect(focusedId()).toBe("member-2");
    press(row(2), "End");
    expect(focusedId()).toBe("member-5");
    press(row(5), "Home");
    expect(focusedId()).toBe("member-1");
  });

  it("focus follows the member when its row is rebuilt", () => {
    const members = roster();
    mountWith(members);
    row(2).focus();
    setTestMembers(members.map((m) => (m.id === 2 ? { ...m, displayName: "Bobby" } : m)));
    membersStore.flush();
    expect(document.activeElement).toBe(row(2));
  });

  it("search keeps only matches", () => {
    mountWith(roster());
    const box = container.querySelector<HTMLInputElement>('[data-testid="member-search"]')!;
    box.value = "e";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    expect(
      Array.from(container.querySelectorAll(".member-item")).map((el) =>
        el.getAttribute("data-testid"),
      ),
    ).toEqual(["member-4", "member-5"]);
  });

  it("a group header's count patches in place", () => {
    mountWith(roster());
    const header = container.querySelector(".member-role-group") as HTMLElement;
    expect(header.textContent).toBe("ADMIN — 1");
    setTestMembers([...roster(), makeMember({ id: 6, username: "fay", role: "admin" })]);
    membersStore.flush();
    expect(container.querySelector(".member-role-group")).toBe(header);
    expect(header.textContent).toBe("ADMIN — 2");
  });

  it("right-click opens the member menu", async () => {
    mountWith(roster());
    await rightClickMember(container, 3);
    expect(document.body.querySelector(".context-menu")).not.toBeNull();
    document.body.querySelector(".context-menu")?.remove();
  });

  it("destroy removes every row", () => {
    mountWith(roster());
    list!.destroy?.();
    expect(container.querySelectorAll(".member-item")).toHaveLength(0);
  });

  it("itemKind(item) equals modelKind(model(item)) across a mixed roster", () => {
    const withLines = roster().map((m) => (m.id === 2 ? { ...m, customStatus: "brb" } : m));
    const items: ListItem[] = [
      { kind: "header", key: "h:admin", text: "ADMIN — 1", offline: false },
      ...withLines.map((member): ListItem => ({
        kind: "row",
        key: `m:${member.id}`,
        member,
        colorVar: "var(--text-normal)",
      })),
      { kind: "empty", key: "empty", text: "No members" },
    ];
    for (const item of items) expect(rows.itemKind(item)).toBe(rows.modelKind(rows.model(item)));
    expect(new Set(items.map((i) => rows.itemKind(i))).size).toBeGreaterThan(2);
  });
});
