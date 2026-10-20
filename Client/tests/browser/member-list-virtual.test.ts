import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
// Same stylesheet order as main.ts: tokens, the border-box reset, then app.
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/app.css";
import { createMemberList, type MemberListComponent } from "@components/MemberList";
import "@components/AdminActions";
import { membersStore, setMembers, updatePresence } from "@stores/members.store";
import { setRoles } from "@stores/channels.store";
import type { ReadyMember, UserStatus } from "@lib/types";
import { buildItems } from "../../src/features/members/memberModel";

// jsdom lays nothing out and has no scroll geometry, so the window over the
// outer scroller (both hosts) can only be checked in a real browser (4.14c).

const OVERSCAN = 10;
const MEMBERS = 2000;

const noop = (): Promise<void> => Promise.resolve();

function roster(count: number): ReadyMember[] {
  const members: ReadyMember[] = [];
  for (let id = 1; id <= count; id++) {
    const status: UserStatus = id % 20 < 3 ? "online" : id % 20 === 3 ? "idle" : "offline";
    members.push({
      id,
      username: `user${String(id).padStart(4, "0")}`,
      avatar: null,
      role: id === 1 ? "owner" : id <= 6 ? "admin" : "member",
      status,
      display_name: id % 3 === 0 ? `Nick ${String(id).padStart(4, "0")}` : null,
      custom_status: id % 5 === 0 && status !== "offline" ? `busy ${id}` : null,
    });
  }
  return members;
}

interface Host {
  readonly scroller: HTMLElement;
  readonly list: MemberListComponent;
  readonly root: HTMLElement;
}

function createList(): MemberListComponent {
  return createMemberList({
    currentUserRole: "member",
    onKick: noop,
    onBan: () => {},
    onChangeRole: noop,
    onToggleBlock: noop,
  });
}

function mountColumn(): Host {
  const column = document.createElement("aside");
  column.id = "member-column";
  column.className = "member-column";
  column.style.height = "520px";
  const body = document.createElement("div");
  body.className = "member-column-body";
  const panel = document.createElement("div");
  panel.className = "member-panel";
  const list = createList();
  list.mount(panel);
  body.appendChild(panel);
  column.appendChild(body);
  document.body.appendChild(column);
  return { scroller: body, list, root: panel.querySelector<HTMLElement>(".member-list")! };
}

function mountSidebar(): Host {
  const section = document.createElement("div");
  section.className = "sidebar-members-section sized";
  section.style.height = "420px";
  section.style.width = "240px";
  const content = document.createElement("div");
  content.className = "sidebar-members-content";
  const panel = document.createElement("div");
  panel.className = "member-panel";
  const list = createList();
  list.mount(panel);
  content.appendChild(panel);
  section.appendChild(content);
  document.body.appendChild(section);
  return { scroller: content, list, root: panel.querySelector<HTMLElement>(".member-list")! };
}

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Enough frames for the scheduled render, its measuring pass and any resize report. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await frame();
}

function rows(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".member-item")];
}

function rowFor(root: HTMLElement, id: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="member-${id}"]`);
}

/** The id of the last member of the OFFLINE group, from the same model the list draws. */
function lastMemberId(): number {
  const items = buildItems(membersStore.getState().members, [], "");
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "row") return item.member.id;
  }
  throw new Error("no rows");
}

function expectNoOverlap(root: HTMLElement): void {
  const placed = [...root.children]
    .map((el) => el.getBoundingClientRect())
    .toSorted((a, b) => a.top - b.top);
  expect(placed.length).toBeGreaterThan(1);
  for (let i = 1; i < placed.length; i++) {
    expect(placed[i]!.top).toBeGreaterThanOrEqual(placed[i - 1]!.bottom - 0.5);
  }
}

function expectWindowBound(host: Host): void {
  const drawn = rows(host.root);
  expect(drawn.length).toBeGreaterThan(0);
  const rowHeight = Math.min(...drawn.map((el) => el.getBoundingClientRect().height));
  const bound = Math.ceil(host.scroller.clientHeight / rowHeight) + 2 * OVERSCAN + 2;
  expect(drawn.length).toBeLessThanOrEqual(bound);
  expect(host.scroller.scrollHeight).toBeGreaterThan(host.scroller.clientHeight * 20);
}

let mounted: Host | null = null;

beforeEach(() => {
  setRoles([]);
  setMembers(roster(MEMBERS));
  membersStore.flush();
});

afterEach(() => {
  mounted?.list.destroy?.();
  mounted = null;
  document.body.replaceChildren();
  document.documentElement.style.removeProperty("--font-size");
  vi.restoreAllMocks();
});

describe("member list windowing above 200 members (real layout)", () => {
  it("column host: rendered .member-item count is at most ceil(viewport/rowHeight) + 2×overscan + 2", async () => {
    mounted = mountColumn();
    await settle();
    expectWindowBound(mounted);
  });

  it("sidebar host: the same bound inside .sidebar-members-content", async () => {
    mounted = mountSidebar();
    await settle();
    expectWindowBound(mounted);
  });

  it("scrolling to the bottom renders the last OFFLINE member at its offset", async () => {
    const host = (mounted = mountColumn());
    await settle();
    expect(rowFor(host.root, lastMemberId())).toBeNull();

    host.scroller.scrollTop = host.scroller.scrollHeight;
    await settle();

    const last = rowFor(host.root, lastMemberId());
    expect(last).not.toBeNull();
    const box = last!.getBoundingClientRect();
    const view = host.scroller.getBoundingClientRect();
    expect(box.bottom).toBeLessThanOrEqual(view.bottom + 1);
    expect(box.top).toBeGreaterThanOrEqual(view.top);
    // Padding below the last row is the root's own 8px plus the row's 1px margin.
    expect(host.root.getBoundingClientRect().bottom - box.bottom).toBeLessThan(12);
    expectNoOverlap(host.root);
  });

  it("the focused row survives scrolling away and a presence move", async () => {
    const host = (mounted = mountColumn());
    await settle();
    const row = rowFor(host.root, 2)!;
    row.focus();
    expect(document.activeElement).toBe(row);
    const before = parseFloat(row.style.top);

    host.scroller.scrollTop = host.scroller.scrollHeight;
    await settle();
    expect(document.activeElement).toBe(row);
    expect(row.isConnected).toBe(true);

    updatePresence(2, "offline");
    membersStore.flush();
    await settle();

    expect(document.activeElement).toBe(row);
    expect(row.isConnected).toBe(true);
    // Offline sorts below every online group, so its offset grew.
    expect(parseFloat(row.style.top)).toBeGreaterThan(before);
  });

  it("the row with an open menu stays rendered while scrolled away", async () => {
    const host = (mounted = mountColumn());
    await settle();
    const row = rowFor(host.root, 2)!;
    const box = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: box.left + 5,
        clientY: box.top + 5,
      }),
    );
    await vi.waitFor(() => expect(document.querySelector(".context-menu")).not.toBeNull());

    host.scroller.scrollTop = host.scroller.scrollHeight;
    await settle();

    expect(row.isConnected).toBe(true);
    expect(rowFor(host.root, 2)).toBe(row);
    expect(rows(host.root).length).toBeGreaterThan(1);
  });

  it("a font-size change re-measures heights and leaves no overlap", async () => {
    const host = (mounted = mountColumn());
    await settle();
    const heightBefore = host.root.getBoundingClientRect().height;

    document.documentElement.style.setProperty("--font-size", "30px");
    await settle();
    host.scroller.scrollTop += 300;
    await settle();

    expect(host.root.getBoundingClientRect().height).toBeGreaterThan(heightBefore);
    expectNoOverlap(host.root);
    // Rendering at the new size is also what a scroll back to the top shows.
    host.scroller.scrollTop = 0;
    await settle();
    expectNoOverlap(host.root);
  });

  it("collapse then expand of the sidebar section renders rows again", async () => {
    const host = (mounted = mountSidebar());
    await settle();
    expect(rows(host.root).length).toBeGreaterThan(0);

    host.scroller.style.display = "none";
    await settle();
    expect(rows(host.root)).toHaveLength(0);
    expect(host.root.outerHTML).not.toContain("NaN");

    host.scroller.style.display = "";
    await settle();
    expect(rows(host.root).length).toBeGreaterThan(0);
    expect(host.root.outerHTML).not.toContain("NaN");
    expectNoOverlap(host.root);
  });

  it("a font-size change while no header is drawn leaves no overlap at the top", async () => {
    const host = (mounted = mountColumn());
    await settle();
    host.scroller.scrollTop = host.scroller.scrollHeight * 0.6;
    await settle();
    expect(host.root.querySelector(".member-role-group")).toBeNull();

    document.documentElement.style.setProperty("--font-size", "30px");
    await settle();
    host.scroller.scrollTop = 0;
    await settle();

    expectNoOverlap(host.root);
  });

  it("a font-size change while the section is collapsed leaves no overlap on expand", async () => {
    const host = (mounted = mountSidebar());
    await settle();

    host.scroller.style.display = "none";
    await settle();
    document.documentElement.style.setProperty("--font-size", "30px");
    await settle();
    host.scroller.style.display = "";
    await settle();

    expect(rows(host.root).length).toBeGreaterThan(0);
    expectNoOverlap(host.root);
  });

  it("a taller header drawn next to a shorter one already measured leaves no overlap", async () => {
    const long = "Members of the very long wrapping role name";
    setRoles([
      { id: 1, name: "owner", color: null, permissions: 0 },
      { id: 2, name: "admin", color: null, permissions: 0 },
      { id: 3, name: "member", color: null, permissions: 0 },
      { id: 4, name: "crew", color: null, permissions: 0 },
      { id: 5, name: long, color: null, permissions: 0 },
    ]);
    setMembers(
      roster(MEMBERS).map((m) =>
        m.id > 1975 && m.id <= 1990
          ? { ...m, role: "crew", status: "online" as const, custom_status: null }
          : m.id > 1990
            ? { ...m, role: long.toLowerCase(), status: "online" as const, custom_status: null }
            : m,
      ),
    );
    membersStore.flush();
    const host = (mounted = mountSidebar());
    await settle();
    const crew = () =>
      [...host.root.querySelectorAll<HTMLElement>(".member-role-group")].find((el) =>
        el.textContent?.startsWith("CREW"),
      );
    // Walk down until the short CREW header is drawn, then jump so the long
    // header and the rows after it are drawn in the same frame.
    while (crew() === undefined) {
      host.scroller.scrollTop += 300;
      await settle();
    }
    host.scroller.scrollTop += 900;
    await settle();
    const wrapped = [...host.root.querySelectorAll<HTMLElement>(".member-role-group")].find((el) =>
      el.textContent?.startsWith("MEMBERS OF"),
    );
    expect(wrapped).toBeDefined();
    expect(wrapped!.getBoundingClientRect().height).toBeGreaterThan(
      crew()!.getBoundingClientRect().height,
    );
    expectNoOverlap(host.root);
  });

  it("focusMember for a gone member focuses a visible row and does not scroll", async () => {
    const host = (mounted = mountColumn());
    await settle();
    rowFor(host.root, 2)!.focus();
    host.scroller.scrollTop = host.scroller.scrollHeight * 0.5;
    await settle();
    const at = host.scroller.scrollTop;
    // The pinned row 2 is drawn first, far above the view.
    expect(rows(host.root)[0]).toBe(rowFor(host.root, 2));

    const el = host.list.focusMember(9_999_999);
    await settle();

    expect(el).not.toBeNull();
    expect(el).not.toBe(rowFor(host.root, 2));
    expect(document.activeElement).toBe(el);
    expect(host.scroller.scrollTop).toBe(at);
    const view = host.scroller.getBoundingClientRect();
    const box = el!.getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(view.top);
    expect(box.bottom).toBeLessThanOrEqual(view.bottom);
  });

  it("Escape on a menu whose row was scrolled out of view focuses that row, still rendered", async () => {
    const host = (mounted = mountColumn());
    await settle();
    const row = rowFor(host.root, 2)!;
    row.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await vi.waitFor(() => expect(document.querySelector(".context-menu")).not.toBeNull());
    await vi.waitFor(() => expect(document.activeElement?.closest(".context-menu")).not.toBeNull());

    host.scroller.scrollTop = host.scroller.scrollHeight;
    await settle();
    await userEvent.keyboard("{Escape}");
    await settle();

    expect(document.querySelector(".context-menu")).toBeNull();
    expect(row.isConnected).toBe(true);
    expect(rowFor(host.root, 2)).toBe(row);
    expect(document.activeElement).toBe(row);
  });

  it("End renders and focuses the last member", async () => {
    const host = (mounted = mountColumn());
    await settle();
    const first = rowFor(host.root, 2)!;
    first.focus();
    const last = lastMemberId();
    expect(rowFor(host.root, last)).toBeNull();

    await userEvent.keyboard("{End}");
    await settle();

    const el = rowFor(host.root, last);
    expect(el).not.toBeNull();
    expect(document.activeElement).toBe(el);
  });

  it("destroy cancels the frame and leaves no rows", async () => {
    const scheduled: number[] = [];
    const request = window.requestAnimationFrame.bind(window);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      const id = request(cb);
      scheduled.push(id);
      return id;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame");

    const host = mountColumn();
    expect(scheduled).toHaveLength(1);
    host.list.destroy?.();
    expect(cancel).toHaveBeenCalledWith(scheduled[0]);
    await settle();
    expect(document.querySelectorAll(".member-item")).toHaveLength(0);

    // A rendered list leaves nothing behind either, and a later roster change
    // draws nothing.
    const again = mountColumn();
    await settle();
    expect(rows(again.root).length).toBeGreaterThan(0);
    again.list.destroy?.();
    updatePresence(2, "offline");
    membersStore.flush();
    await settle();
    expect(document.querySelectorAll(".member-item")).toHaveLength(0);
  });
});
