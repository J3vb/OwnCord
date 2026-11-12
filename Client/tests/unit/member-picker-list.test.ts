// The member picker's list: sort order, lazy avatars and the search filter.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemberPickerModal } from "../../src/features/direct-messages/MemberPickerModal";
import * as avatar from "../../src/features/profiles/avatar";
import { membersStore, type Member } from "../../src/stores/members.store";
import { memberRow, useMemberPickerHarness } from "../helpers/memberPickerHarness";

let container: HTMLDivElement;
const { opened } = useMemberPickerHarness((c) => {
  container = c;
});

function open(members: Member[]): void {
  membersStore.setState(() => ({
    members: new Map(members.map((m) => [m.id, m])),
    typingUsers: new Map(),
  }));
  const picker = createMemberPickerModal({ onSelect: vi.fn(), onClose: vi.fn() });
  picker.mount(container);
  opened.push(picker);
}

function ids(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".dm-member-picker-item")].map(
    (el) => el.dataset["testid"] ?? "",
  );
}

describe("the member picker list", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists reachable people first, then by name ignoring case and accents", () => {
    open([
      { ...memberRow(2, "zed"), status: "offline" },
      memberRow(3, "bob"),
      { ...memberRow(4, "x"), displayName: "Ábel" },
      memberRow(5, "Cara"),
      memberRow(6, "amy"),
    ]);
    expect(ids()).toEqual([
      "dm-picker-member-4",
      "dm-picker-member-6",
      "dm-picker-member-3",
      "dm-picker-member-5",
      "dm-picker-member-2",
    ]);
  });

  it("queues avatars for when their row is visible", () => {
    const spy = vi.spyOn(avatar, "createAvatarElement");
    open([memberRow(2, "amy"), memberRow(3, "bob")]);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const call of spy.mock.calls) expect(call[1]?.deferUntilVisible).toBe(true);
  });

  it("hides rows that miss the search and shows the empty notice when none match", () => {
    open([memberRow(2, "amy"), memberRow(3, "bob")]);
    const input = document.querySelector<HTMLInputElement>("input[type='search'], input")!;
    input.value = "BO";
    input.dispatchEvent(new Event("input"));
    const hidden = (id: number): boolean =>
      document.querySelector<HTMLElement>(`[data-testid='dm-picker-member-${id}']`)?.hidden ===
      true;
    expect([hidden(2), hidden(3)]).toEqual([true, false]);
    expect(document.querySelector<HTMLElement>("[data-testid='dm-picker-empty']")!.hidden).toBe(
      true,
    );
    input.value = "zzz";
    input.dispatchEvent(new Event("input"));
    expect([hidden(2), hidden(3)]).toEqual([true, true]);
    expect(document.querySelector<HTMLElement>("[data-testid='dm-picker-empty']")!.hidden).toBe(
      false,
    );
  });
});
