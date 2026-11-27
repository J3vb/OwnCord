import { describe, expect, it } from "vitest";
import { createMemberList, type MemberListOptions } from "../../src/features/members/MemberList";
import {
  classicMemberRows,
  memberRows,
  type MemberRowRenderer,
  type MemberRows,
  type RowContextSource,
} from "../../src/features/members/memberRowRenderer";
import {
  MEMBER_PATCH_FIELDS,
  type MemberItemModel,
} from "../../src/features/members/memberRow.view";
import { buildModel, flattenModel, type ListItem } from "../../src/features/members/memberModel";
import { membersStore, updatePresence, type Member } from "@stores/members.store";
import {
  defaultOpts,
  makeMember,
  rightClickMember,
  setTestMembers,
  useMemberListSuite,
} from "./memberListHarness";

/** One way of drawing the shared list, as the contract cases see it. */
export interface ContractEntry {
  /** What the entry adds to the default options. `view` is always given, so
   *  the kind case can run the renderer through `view.use`. */
  readonly options: Pick<MemberListOptions, "flatten"> & { readonly view: MemberRows };
  /** Matches every group header the entry draws. */
  readonly headerSelector: string;
  /** The first header's text for the base roster, and after `fay` (an online
   *  admin with no game) joins it. */
  readonly firstHeader: { readonly before: string; readonly after: string };
}

/** The base roster: ann is an online admin, bob and cy online members, and
 *  dee and eli are offline. */
function baseRoster(): Member[] {
  return [
    makeMember({ id: 1, username: "ann", role: "admin" }),
    makeMember({ id: 2, username: "bob" }),
    makeMember({ id: 3, username: "cy" }),
    makeMember({ id: 4, username: "dee", status: "offline" }),
    makeMember({ id: 5, username: "eli", status: "offline" }),
  ];
}

const FAY = makeMember({ id: 6, username: "fay", role: "admin" });

function withName(members: readonly Member[], id: number, displayName: string): Member[] {
  return members.map((m) => (m.id === id ? { ...m, displayName } : m));
}

const key = (target: Element, k: string): void => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
};

const rebuild = (members: Member[]): void => {
  setTestMembers(members);
  membersStore.flush();
};

/** Runs the shared list cases, in full mode, against one entry. */
export function runListContract(name: string, entry: ContractEntry): void {
  describe(`member list contract: ${name}`, () => {
    let host: HTMLDivElement;
    let list: ReturnType<typeof createMemberList> | null = null;

    useMemberListSuite(
      (c) => {
        host = c;
        list = null;
      },
      () => list,
    );

    const mount = (members: Member[]): void => {
      setTestMembers(members);
      list = createMemberList({ ...defaultOpts(), ...entry.options });
      list.mount(host);
    };
    const rowOf = (id: number): HTMLElement => {
      const el = host.querySelector<HTMLElement>(`[data-testid="member-${id}"]`);
      if (el === null) throw new Error(`no row for member ${id}`);
      return el;
    };
    const drawnIds = (): (string | null)[] =>
      [...host.querySelectorAll(".member-item")].map((el) => el.getAttribute("data-testid"));
    it("draws one focusable, named row per member", () => {
      mount(baseRoster());
      expect(drawnIds()).toHaveLength(5);
      for (const member of baseRoster()) {
        const el = rowOf(member.id);
        expect(el.getAttribute("role")).toBe("button");
        expect(el.tabIndex).toBe(0);
        expect(el.getAttribute("aria-label") || el.textContent).toBeTruthy();
      }
    });

    it("patches a row in place on a presence change", () => {
      mount(baseRoster());
      const kept = rowOf(3);
      updatePresence(3, "dnd");
      membersStore.flush();
      expect(rowOf(3)).toBe(kept);
      expect(kept.querySelector(".mi-status")?.getAttribute("aria-label")).toBe("Do Not Disturb");
    });

    it("aborts a rebuilt row's listeners", () => {
      const members = baseRoster();
      mount(members);
      const stale = rowOf(3);
      rebuild(withName(members, 3, "Cyrus"));
      expect(rowOf(3)).not.toBe(stale);
      stale.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
      expect(document.querySelector('[data-testid="user-profile-popup"]')).toBeNull();
    });

    it("walks rows only with the arrows, Home and End", () => {
      mount(baseRoster());
      rowOf(1).focus();
      key(rowOf(1), "ArrowDown");
      expect(document.activeElement).toBe(rowOf(2));
      key(rowOf(2), "End");
      expect(document.activeElement).toBe(rowOf(5));
      key(rowOf(5), "Home");
      expect(document.activeElement).toBe(rowOf(1));
    });

    it("keeps focus on a member whose row is rebuilt", () => {
      const members = baseRoster();
      mount(members);
      rowOf(3).focus();
      rebuild(withName(members, 3, "Cyrus"));
      expect(document.activeElement).toBe(rowOf(3));
    });

    it("shows only the members a search matches", () => {
      mount(baseRoster());
      const box = host.querySelector<HTMLInputElement>('[data-testid="member-search"]')!;
      box.value = "e";
      box.dispatchEvent(new Event("input", { bubbles: true }));
      expect(drawnIds()).toEqual(["member-4", "member-5"]);
    });

    it("patches the first header's count in place", () => {
      mount(baseRoster());
      const header = host.querySelector<HTMLElement>(entry.headerSelector)!;
      expect(header.textContent).toBe(entry.firstHeader.before);
      rebuild([...baseRoster(), FAY]);
      expect(host.querySelector(entry.headerSelector)).toBe(header);
      expect(header.textContent).toBe(entry.firstHeader.after);
    });

    it("opens the member menu on right-click", async () => {
      mount(baseRoster());
      await rightClickMember(host, 2);
      const menu = document.body.querySelector(".context-menu");
      expect(menu).not.toBeNull();
      menu?.remove();
    });

    it("removes every row on destroy", () => {
      mount(baseRoster());
      list?.destroy?.();
      expect(host.querySelector(".member-item")).toBeNull();
    });

    it("gives each item the same kind as its drawn model", () => {
      const members = baseRoster().map((m) => (m.id === 3 ? { ...m, customStatus: "afk" } : m));
      setTestMembers(members);
      const flatten = entry.options.flatten ?? flattenModel;
      const items: ListItem[] = [
        ...flatten(buildModel(membersStore.getState().members, []), "", new Set()),
        { kind: "empty", key: "empty", text: "Nobody here" },
      ];
      const kinds = entry.options.view.use((rows, ctx) =>
        items.map((item) => {
          expect(rows.itemKind(item)).toBe(rows.modelKind(rows.model(item, ctx)));
          return rows.itemKind(item);
        }),
      );
      expect(new Set(kinds).size).toBeGreaterThan(2);
    });
  });
}

/** Classic's rows model with a `tag` read from the row context. */
export type TaggedModel = MemberItemModel & { readonly tag: string };

/** A test renderer: Classic's rows, plus `data-tag` from the context, a patch field. */
export const taggedRows: MemberRowRenderer<TaggedModel, { readonly tag: string }> = {
  model: (item, ctx) => ({ ...classicMemberRows.model(item), tag: ctx.tag }),
  draw: (model) => {
    const el = classicMemberRows.draw(model);
    el.dataset["tag"] = model.tag;
    return el;
  },
  patch: {
    fields: [...MEMBER_PATCH_FIELDS, "tag"],
    apply: (el, next) => {
      classicMemberRows.patch.apply(el, next);
      if (el instanceof HTMLElement) el.dataset["tag"] = next.tag;
    },
  },
  itemKind: classicMemberRows.itemKind,
  modelKind: classicMemberRows.modelKind,
  estimatedHeights: classicMemberRows.estimatedHeights,
};

/** A row context the test sets by hand. `seen` lists every tag the renderer's
 *  `model` read, and `listening` is true while the list is subscribed. */
export interface TagSource {
  readonly view: MemberRows;
  readonly seen: string[];
  set(tag: string): void;
  listening(): boolean;
}

export function tagSource(first: string): TagSource {
  let ctx = { tag: first };
  let onChange: (() => void) | null = null;
  const seen: string[] = [];
  const source: RowContextSource<{ readonly tag: string }> = {
    read: () => ctx,
    subscribe: (signal, fire) => {
      onChange = fire;
      signal.addEventListener("abort", () => (onChange = null), { once: true });
    },
  };
  const spied: MemberRowRenderer<TaggedModel, { readonly tag: string }> = {
    ...taggedRows,
    model: (item, c) => {
      seen.push(c.tag);
      return taggedRows.model(item, c);
    },
  };
  return {
    view: memberRows(spied, source),
    seen,
    set: (tag) => {
      ctx = { tag };
      onChange?.();
    },
    listening: () => onChange !== null,
  };
}
