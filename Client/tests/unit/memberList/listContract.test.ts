import { describe, expect, it, vi } from "vitest";
import "../../helpers/memberListMocks";
import "../../../src/features/profiles/userProfilePopup";
import "../../../src/features/moderation/AdminActions";
import { createMemberList } from "../../../src/features/members/MemberList";
import { classicMemberRows, classicView } from "../../../src/features/members/memberRowRenderer";
import { flattenModel, type MemberModel } from "../../../src/features/members/memberModel";
import { membersStore, updatePresence } from "@stores/members.store";
import {
  defaultOpts,
  makeMember,
  setTestMembers,
  useMemberListSuite,
} from "../../helpers/memberListHarness";
import { runListContract, tagSource, type ContractEntry } from "../../helpers/memberListContract";

const classicEntry: ContractEntry = {
  options: { view: classicView() },
  headerSelector: ".member-role-group",
  firstHeader: { before: "ADMIN — 1", after: "ADMIN — 2" },
};

const ENTRIES: Readonly<Record<string, ContractEntry>> = {
  classic: classicEntry,
};

for (const [name, entry] of Object.entries(ENTRIES)) runListContract(name, entry);

const roster = () => [
  makeMember({ id: 1, username: "ann" }),
  makeMember({ id: 2, username: "bob" }),
  makeMember({ id: 3, username: "cy", status: "offline" }),
];

describe("member list options: view, rows and flatten", () => {
  let host: HTMLDivElement;
  let list: ReturnType<typeof createMemberList> | null = null;
  useMemberListSuite(
    (c) => {
      host = c;
      list = null;
    },
    () => list,
  );

  const tagOf = (id: number): string | undefined =>
    host.querySelector<HTMLElement>(`[data-testid="member-${id}"]`)?.dataset["tag"];

  it("a context change with no member change patches the drawn rows in place", () => {
    setTestMembers(roster());
    const source = tagSource("one");
    list = createMemberList({ ...defaultOpts(), view: source.view });
    list.mount(host);
    const row = host.querySelector<HTMLElement>('[data-testid="member-2"]')!;
    row.focus();
    expect(tagOf(2)).toBe("one");

    source.set("two");

    expect(source.seen.at(-1)).toBe("two");
    expect(host.querySelector('[data-testid="member-2"]')).toBe(row);
    expect(tagOf(1)).toBe("two");
    expect(tagOf(2)).toBe("two");
    expect(document.activeElement).toBe(row);
  });

  it("a member change reads the current context", () => {
    setTestMembers(roster());
    const source = tagSource("one");
    list = createMemberList({ ...defaultOpts(), view: source.view });
    list.mount(host);
    source.set("two");
    updatePresence(1, "idle");
    membersStore.flush();
    expect(tagOf(1)).toBe("two");
  });

  it("destroy ends the view's subscription", () => {
    setTestMembers(roster());
    const source = tagSource("one");
    list = createMemberList({ ...defaultOpts(), view: source.view });
    list.mount(host);
    expect(source.listening()).toBe(true);
    list.destroy?.();
    list = null;
    expect(source.listening()).toBe(false);
  });

  it("the view wins over rows", () => {
    setTestMembers(roster());
    const source = tagSource("view");
    list = createMemberList({ ...defaultOpts(), rows: classicMemberRows, view: source.view });
    list.mount(host);
    expect(tagOf(1)).toBe("view");
  });

  it("flatten gets the model, the search text and an empty collapsed set", () => {
    setTestMembers(roster());
    const flatten = vi.fn((model: MemberModel, query: string, _collapsed: ReadonlySet<string>) =>
      flattenModel(model, query),
    );
    list = createMemberList({ ...defaultOpts(), flatten });
    list.mount(host);
    const box = host.querySelector<HTMLInputElement>('[data-testid="member-search"]')!;
    box.value = "bo";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    const [model, query, collapsed] = flatten.mock.lastCall!;
    expect(model.members.size).toBe(3);
    expect(query).toBe("bo");
    expect(collapsed.size).toBe(0);
    expect(host.querySelectorAll(".member-item")).toHaveLength(1);
  });

  it("a flatten of its own decides the drawn items", () => {
    setTestMembers(roster());
    list = createMemberList({
      ...defaultOpts(),
      flatten: (model) =>
        [...model.members.values()].map((member) => ({
          kind: "row" as const,
          key: `u:${member.id}`,
          member,
          colorVar: "var(--text-normal)",
        })),
    });
    list.mount(host);
    expect(host.querySelector(".member-role-group")).toBeNull();
    expect(host.querySelectorAll(".member-item")).toHaveLength(3);
  });
});
