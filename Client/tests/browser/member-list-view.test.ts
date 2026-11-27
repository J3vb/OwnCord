import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Same stylesheet order as main.ts: tokens, the border-box reset, then app.
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/app.css";
import { createMemberList, type MemberListComponent } from "../../src/features/members/MemberList";
import "../../src/features/moderation/AdminActions";
import { membersStore, setMembers } from "@stores/members.store";
import { setRoles } from "@stores/channels.store";
import type { ReadyMember } from "@lib/types";
import { tagSource, type TagSource } from "../helpers/memberListContract";

// A row context change in virtual mode (above 200 members) reaches the drawn
// rows on the next frame, as a patch: the same elements, focus kept.

const MEMBERS = 600;
const noop = (): Promise<void> => Promise.resolve();

function roster(): ReadyMember[] {
  return Array.from({ length: MEMBERS }, (_, i) => ({
    id: i + 1,
    username: `user${String(i + 1).padStart(4, "0")}`,
    avatar: null,
    role: "member",
    status: i % 3 === 0 ? "offline" : "online",
  }));
}

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await frame();
}

let list: MemberListComponent | null = null;

function mountColumn(source: TagSource): HTMLElement {
  const column = document.createElement("aside");
  column.id = "member-column";
  column.className = "member-column";
  column.style.height = "520px";
  const body = document.createElement("div");
  body.className = "member-column-body";
  const panel = document.createElement("div");
  panel.className = "member-panel";
  list = createMemberList({
    currentUserRole: "member",
    onKick: noop,
    onBan: () => {},
    onChangeRole: noop,
    onToggleBlock: noop,
    view: source.view,
  });
  list.mount(panel);
  body.appendChild(panel);
  column.appendChild(body);
  document.body.appendChild(column);
  return panel.querySelector<HTMLElement>(".member-list")!;
}

function drawnRows(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".member-item")];
}

beforeEach(() => {
  setRoles([]);
  setMembers(roster());
  membersStore.flush();
});

afterEach(() => {
  list?.destroy?.();
  list = null;
  document.body.replaceChildren();
});

describe("member list view: a row context change in virtual mode", () => {
  it("patches the drawn rows on the next frame, keeping the elements and focus", async () => {
    const source = tagSource("one");
    const root = mountColumn(source);
    await settle();
    const before = drawnRows(root);
    expect(before.length).toBeGreaterThan(0);
    expect(before.length).toBeLessThan(MEMBERS);
    expect(before.every((row) => row.dataset["tag"] === "one")).toBe(true);
    const focused = before[2]!;
    focused.focus();

    source.set("two");
    // Nothing is drawn until the frame runs.
    expect(focused.dataset["tag"]).toBe("one");
    await frame();

    expect(source.seen.at(-1)).toBe("two");
    const after = drawnRows(root);
    expect(after).toEqual(before);
    expect(after.every((row) => row.dataset["tag"] === "two")).toBe(true);
    expect(document.activeElement).toBe(focused);
  });

  it("a member scrolled into view later is drawn with the current context", async () => {
    const source = tagSource("one");
    const root = mountColumn(source);
    await settle();
    source.set("two");
    await settle();
    const scroller = root.closest<HTMLElement>(".member-column-body")!;
    scroller.scrollTop = scroller.scrollHeight;
    await settle();
    const rows = drawnRows(root);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.dataset["tag"] === "two")).toBe(true);
  });
});
