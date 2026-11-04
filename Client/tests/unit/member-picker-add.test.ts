/**
 * WP 3B-11a: the member picker's add mode. People already in the group are not
 * listed, the selection is limited to the slots left, the button says Add, and
 * a refusal shows in the picker with the selection kept.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { memberRow, useMemberPickerHarness } from "../helpers/memberPickerHarness";
import { createMemberPickerModal } from "../../src/pages/main-page/MemberPickerModal";
import { membersStore } from "@stores/members.store";
import { showToast } from "@lib/ui/toast";

vi.mock("@lib/ui/toast", () => ({ showToast: vi.fn() }));

let container: HTMLDivElement;
const { opened } = useMemberPickerHarness((c) => {
  container = c;
});

beforeEach(() => {
  membersStore.setState((prev) => ({
    ...prev,
    members: new Map([1, 2, 3, 4, 5, 6].map((id) => [id, memberRow(id, `user${id}`)])),
  }));
});

function open(opts: Partial<Parameters<typeof createMemberPickerModal>[0]> = {}) {
  const onAdd = vi.fn().mockResolvedValue(null);
  const picker = createMemberPickerModal({
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onAdd,
    excludeIds: new Set([1, 2]),
    maxSelect: 2,
    ...opts,
  });
  picker.mount(container);
  opened.push(picker);
  return { onAdd: (opts.onAdd ?? onAdd) as ReturnType<typeof vi.fn> };
}
const q = <T extends HTMLElement>(id: string): T | null =>
  document.querySelector<T>(`[data-testid="${id}"]`);
const rows = (): string[] =>
  [...document.querySelectorAll<HTMLElement>(".dm-member-picker-item")].map(
    (el) => el.dataset["testid"]!,
  );

describe("member picker add mode", () => {
  it("lists only people who are not in the group, and offers no group name", () => {
    open();
    expect(rows()).toEqual([
      "dm-picker-member-3",
      "dm-picker-member-4",
      "dm-picker-member-5",
      "dm-picker-member-6",
    ]);
    expect(q("dm-group-name")).toBeNull();
    expect(document.querySelector("h3")?.textContent).toBe("Add People");
  });

  it("limits the selection to the slots left", () => {
    open();
    q("dm-picker-member-3")!.click();
    q("dm-picker-member-4")!.click();
    q("dm-picker-member-5")!.click();
    expect(q("dm-picker-member-5")!.classList.contains("selected")).toBe(false);
    expect(document.querySelectorAll(".dm-member-picker-item.selected")).toHaveLength(2);
  });

  it("the button says Add and submits the picked ids, closing on success", async () => {
    const onClose = vi.fn();
    const { onAdd } = open({ onClose });
    expect(q("dm-picker-create")!.style.display).toBe("none");
    q("dm-picker-member-4")!.click();
    q("dm-picker-member-6")!.click();
    expect(q("dm-picker-create")!.textContent).toBe("Add");
    q("dm-picker-create")!.click();
    expect(onAdd).toHaveBeenCalledWith([4, 6]);
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("a single pick still goes through Add, never opens a 1:1 DM", () => {
    const onSelect = vi.fn();
    const { onAdd } = open({ onSelect });
    q("dm-picker-member-3")!.click();
    q("dm-picker-create")!.click();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onAdd).toHaveBeenCalledWith([3]);
  });

  it("shows a refusal in the picker and keeps the selection for another try", async () => {
    const onClose = vi.fn();
    const onAdd = vi.fn().mockResolvedValueOnce("This group is full").mockResolvedValueOnce(null);
    open({ onAdd, onClose });
    q("dm-picker-member-3")!.click();
    q("dm-picker-create")!.click();
    await vi.waitFor(() => expect(q("dm-picker-error")!.hidden).toBe(false));
    expect(q("dm-picker-error")!.textContent).toBe("This group is full");
    expect(onClose).not.toHaveBeenCalled();
    expect(q("dm-picker-member-3")!.classList.contains("selected")).toBe(true);
    expect((q("dm-picker-create") as HTMLButtonElement).disabled).toBe(false);

    q("dm-picker-create")!.click();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onAdd).toHaveBeenCalledTimes(2);
  });

  it("a failure that arrives after the picker was dismissed is shown as a toast", async () => {
    let fail!: (text: string | null) => void;
    const onAdd = vi.fn(() => new Promise<string | null>((r) => (fail = r)));
    open({ onAdd });
    q("dm-picker-member-3")!.click();
    q("dm-picker-create")!.click();
    document.querySelector<HTMLElement>(".btn-secondary")!.click();
    fail("This group is full");
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith("This group is full", "error"));
  });
});
