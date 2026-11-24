import { describe, expect, it } from "vitest";
import {
  buddiesRows,
  type BuddyItemModel,
} from "../../../src/features/members/buddies/buddiesRenderer";
import type { BuddyContext } from "../../../src/features/members/buddies/buddyContext";
import type { VoiceRoom } from "../../../src/features/members/memberVoice";
import type { ListItem } from "../../../src/features/members/memberModel";
import type { Member } from "@stores/members.store";
import { makeMember } from "../../helpers/memberListHarness";

const NO_ROOMS: BuddyContext = { rooms: new Map() };
const LOUNGE: VoiceRoom = { channelId: 6, name: "Lounge", afk: false };
const inRoom = (id: number, room: VoiceRoom = LOUNGE): BuddyContext => ({
  rooms: new Map([[id, room]]),
});
const GAME = { name: "Starfall Tactics", startedAt: 1 };
const SONG = { title: "Song", artist: "A", player: "Spotify", startedAt: 1, durationMs: 0 };
const EVIL = "<img src=x onerror=1>";

const rowItem = (member: Member): ListItem => ({
  kind: "row",
  key: `u:${member.id}`,
  member,
  colorVar: "var(--role-member, #949ba4)",
});
const header: ListItem = {
  kind: "header",
  key: "a:game",
  text: "IN GAME — 2",
  offline: false,
  collapsible: false,
  collapsed: false,
};
const empty: ListItem = { kind: "empty", key: "empty", text: "No members online" };

const modelOf = (item: ListItem, ctx = NO_ROOMS): BuddyItemModel => buddiesRows.model(item, ctx);
const drawItem = (item: ListItem, ctx = NO_ROOMS): HTMLElement =>
  buddiesRows.draw(modelOf(item, ctx));
const draw = (member: Member, ctx = NO_ROOMS): HTMLElement => drawItem(rowItem(member), ctx);

/** Line 2's element: which kind and its text, or null. */
function line2(row: HTMLElement): { cls: string; text: string; icon: string | null } | null {
  const el = row.querySelector<HTMLElement>(".buddy-line2 > *");
  if (el === null) return null;
  return {
    cls: el.className,
    text: el.textContent ?? "",
    icon: el.querySelector("svg")?.getAttribute("data-icon") ?? null,
  };
}

describe("buddies rows: the row contract", () => {
  it("draws a focusable button named and titled after the member", () => {
    const row = draw(makeMember({ id: 7, username: "ada", displayName: "Ada L" }));
    expect([...row.classList]).toEqual(["member-item", "buddy-row"]);
    expect(row.dataset["testid"]).toBe("member-7");
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.getAttribute("aria-haspopup")).toBe("dialog");
    expect(row.getAttribute("aria-label")).toBe("Ada L");
    expect(row.title).toBe("Ada L");
    expect(row.querySelector(".buddy-line1 .mi-name")?.textContent).toBe("Ada L");
    expect(row.querySelector(".mi-avatar #mi-status-7")).not.toBeNull();
    expect(row.getAttribute("aria-describedby")).toBe("mi-status-7");
  });

  it("always draws both lines, and the voice icon hidden out of a room", () => {
    const row = draw(makeMember({ id: 1, username: "ann" }));
    expect(
      row.querySelectorAll(".buddy-lines > .buddy-line1, .buddy-lines > .buddy-line2"),
    ).toHaveLength(2);
    const voice = row.querySelector<HTMLElement>('[data-testid="buddy-voice-1"]')!;
    expect(voice.hidden).toBe(true);
    expect(voice.getAttribute("aria-hidden")).toBe("true");
    expect(voice.hasAttribute("title")).toBe(false);
    expect(row.querySelector("#bi-room-1")).toBeNull();
    expect(line2(row)).toBeNull();
  });

  it("names the room in the icon's tooltip and the row's description", () => {
    const row = draw(makeMember({ id: 1, username: "ann", customStatus: "brb" }), inRoom(1));
    const voice = row.querySelector<HTMLElement>(".buddy-voice")!;
    expect(voice.hidden).toBe(false);
    expect(voice.title).toBe("In Lounge");
    expect(voice.querySelector("svg")?.getAttribute("data-icon")).toBe("volume-2");
    const line1 = row.querySelector(".buddy-line1")!;
    expect(line1.lastElementChild?.id).toBe("bi-room-1");
    expect(line1.lastElementChild?.className).toBe("sr-only");
    expect(line1.lastElementChild?.textContent).toBe("In Lounge");
    expect(row.getAttribute("aria-describedby")).toBe("bi-line-1 bi-room-1 mi-status-1");
  });

  it("gives every item the same kind as its model", () => {
    const list = [
      header,
      empty,
      rowItem(makeMember({ id: 1, username: "a" })),
      rowItem(makeMember({ id: 2, username: "b", activity: GAME, customStatus: "x" })),
    ];
    for (const item of list) {
      expect(buddiesRows.itemKind(item)).toBe(buddiesRows.modelKind(modelOf(item, inRoom(2))));
    }
    expect(list.map((i) => buddiesRows.itemKind(i))).toEqual([0, 3, 1, 1]);
    expect(buddiesRows.estimatedHeights).toEqual([28, 42, 42, 80]);
  });

  it("draws a header and the empty state", () => {
    const el = drawItem(header);
    expect(el.className).toBe("buddies-group");
    expect(el.dataset["testid"]).toBe("buddies-group-game");
    expect(el.querySelector(".buddies-group-text")?.textContent).toBe("IN GAME — 2");
    expect(modelOf(header)).toMatchObject({ kind: "header", group: "a:game", text: "IN GAME — 2" });
    expect(drawItem(empty).querySelector(".member-list-empty-text")?.textContent).toBe(
      "No members online",
    );
  });

  it("dims an offline-status row and keeps the voice icon for one in a room", () => {
    const row = draw(makeMember({ id: 3, username: "cy", status: "invisible" }), inRoom(3));
    expect(row.classList.contains("offline")).toBe(true);
    expect(row.querySelector<HTMLElement>(".buddy-voice")!.hidden).toBe(false);
    expect(row.querySelector("#bi-room-3")?.textContent).toBe("In Lounge");
    expect(draw(makeMember({ id: 4, username: "di", status: "idle" })).classList).not.toContain(
      "offline",
    );
    expect(draw(makeMember({ id: 5, username: "ed", status: "dnd" })).classList).not.toContain(
      "offline",
    );
  });
});

describe("buddies rows: line 2", () => {
  it("shows the game with the controller, even over a custom status", () => {
    const row = draw(makeMember({ id: 1, username: "a", activity: GAME, customStatus: "busy" }));
    expect(line2(row)).toEqual({
      cls: "mi-activity",
      text: "Starfall Tactics",
      icon: "gamepad-2",
    });
    expect(row.querySelector('[data-testid="member-activity-1"]')?.id).toBe("bi-line-1");
    expect(row.getAttribute("aria-describedby")).toBe("bi-line-1 mi-status-1");
  });

  it("shows the custom status before the song, and the song when alone", () => {
    const both = draw(makeMember({ id: 1, username: "a", customStatus: "busy", listening: SONG }));
    expect(line2(both)).toMatchObject({ cls: "mi-custom-status", text: "busy", icon: null });
    expect(both.querySelector('[data-testid="member-custom-status-1"]')?.id).toBe("bi-line-1");
    const song = draw(makeMember({ id: 2, username: "b", customStatus: "", listening: SONG }));
    expect(line2(song)).toEqual({
      cls: "mi-activity",
      text: "Listening to Spotify",
      icon: "music",
    });
  });

  it("offline shows only the custom status, never a stale game or song", () => {
    const stale = { activity: GAME, listening: SONG, status: "offline" as const };
    expect(line2(draw(makeMember({ id: 1, username: "a", ...stale })))).toBeNull();
    expect(
      line2(draw(makeMember({ id: 2, username: "b", ...stale, customStatus: "away" }))),
    ).toMatchObject({ cls: "mi-custom-status", text: "away" });
  });

  it("draws untrusted text as text", () => {
    const named = draw(
      makeMember({ id: 1, username: EVIL, activity: { name: EVIL, startedAt: 1 } }),
    );
    const custom = draw(makeMember({ id: 2, username: "b", customStatus: EVIL }));
    const room = draw(makeMember({ id: 3, username: "c" }), inRoom(3, { ...LOUNGE, name: EVIL }));
    for (const row of [named, custom, room]) expect(row.querySelector("img")).toBeNull();
    expect(named.querySelector(".mi-name")?.textContent).toBe(EVIL);
    expect(named.querySelector(".mi-activity-text")?.textContent).toBe(EVIL);
    expect(custom.querySelector(".mi-custom-status")?.textContent).toBe(EVIL);
    expect(room.querySelector("#bi-room-3")?.textContent).toBe(`In ${EVIL}`);
  });
});

describe("buddies rows: the patch", () => {
  const patch = (el: HTMLElement, member: Member, ctx = NO_ROOMS): void =>
    buddiesRows.patch.apply(el, modelOf(rowItem(member), ctx));

  it("adds, renames and removes the room text and its description entry", () => {
    const member = makeMember({ id: 1, username: "a", customStatus: "brb" });
    const row = draw(member);
    patch(row, member, inRoom(1));
    expect(row.querySelector("#bi-room-1")?.textContent).toBe("In Lounge");
    expect(row.getAttribute("aria-describedby")).toBe("bi-line-1 bi-room-1 mi-status-1");
    const label = row.querySelector("#bi-room-1");
    patch(row, member, inRoom(1, { ...LOUNGE, name: "Den" }));
    expect(row.querySelector("#bi-room-1")).toBe(label);
    expect(label?.textContent).toBe("In Den");
    expect(row.querySelector<HTMLElement>(".buddy-voice")!.title).toBe("In Den");
    patch(row, member, NO_ROOMS);
    expect(row.querySelector("#bi-room-1")).toBeNull();
    expect(row.querySelector<HTMLElement>(".buddy-voice")!.hidden).toBe(true);
    expect(row.getAttribute("aria-describedby")).toBe("bi-line-1 mi-status-1");
  });

  it("dims, undims and moves the dot in place", () => {
    const member = makeMember({ id: 1, username: "a" });
    const row = draw(member);
    patch(row, { ...member, status: "offline" });
    expect(row.classList.contains("offline")).toBe(true);
    patch(row, { ...member, status: "dnd" });
    expect(row.classList.contains("offline")).toBe(false);
    expect(row.querySelector(".mi-status")?.getAttribute("aria-label")).toBe("Do Not Disturb");
  });

  it("patches a header's and the empty state's text", () => {
    const el = drawItem(header);
    buddiesRows.patch.apply(el, modelOf({ ...header, text: "IN GAME — 3" }));
    expect(el.textContent).toBe("IN GAME — 3");
    const none = drawItem(empty);
    buddiesRows.patch.apply(none, modelOf({ ...empty, text: "No members match your search" }));
    expect(none.textContent).toBe("No members match your search");
  });

  it("lists exactly the patch fields of the model table", () => {
    expect([...buddiesRows.patch.fields].sort()).toEqual(
      ["collapsed", "dimmed", "mobile", "room", "status", "text"].sort(),
    );
  });
});

describe("buddies rows: foldable headers", () => {
  const foldable: ListItem = { ...header, collapsible: true };

  it("draws a foldable header as a focusable button with a hidden chevron first", () => {
    const el = drawItem(foldable);
    expect(el.getAttribute("role")).toBe("button");
    expect(el.getAttribute("tabindex")).toBe("0");
    expect(el.getAttribute("aria-expanded")).toBe("true");
    expect(el.getAttribute("aria-controls")).toBeNull();
    const chevron = el.firstElementChild;
    expect(chevron?.classList.contains("buddies-group-chevron")).toBe(true);
    expect(chevron?.getAttribute("aria-hidden")).toBe("true");
    expect(chevron?.classList.contains("collapsed")).toBe(false);
    expect(el.textContent).toBe("IN GAME — 2");
  });

  it("draws a folded header collapsed", () => {
    const el = drawItem({ ...foldable, collapsed: true });
    expect(el.getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector(".buddies-group-chevron")?.classList.contains("collapsed")).toBe(true);
  });

  it("draws a header during a search as plain text", () => {
    const el = drawItem(header);
    for (const name of ["role", "tabindex", "aria-expanded"]) {
      expect(el.hasAttribute(name), name).toBe(false);
    }
    expect(el.querySelector(".buddies-group-chevron")).toBeNull();
  });

  it("a fold is patched in place: aria-expanded and the chevron's turn", () => {
    const el = drawItem(foldable);
    buddiesRows.patch.apply(el, modelOf({ ...foldable, collapsed: true, text: "IN GAME — 3" }));
    expect(el.getAttribute("aria-expanded")).toBe("false");
    expect(el.querySelector(".buddies-group-chevron")?.classList.contains("collapsed")).toBe(true);
    expect(el.textContent).toBe("IN GAME — 3");
    buddiesRows.patch.apply(el, modelOf(foldable));
    expect(el.getAttribute("aria-expanded")).toBe("true");
    expect(el.querySelector(".buddies-group-chevron")?.classList.contains("collapsed")).toBe(false);
  });

  it("models the fold fields from the item", () => {
    expect(modelOf({ ...foldable, collapsed: true })).toMatchObject({
      kind: "header",
      group: "a:game",
      collapsible: true,
      collapsed: true,
    });
  });
});
