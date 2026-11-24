import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Same stylesheet order as main.ts: tokens, the border-box reset, then app.
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/app.css";
import { createMemberList, type MemberListComponent } from "../../src/features/members/MemberList";
import "../../src/features/moderation/AdminActions";
import { buddiesListOptions } from "../../src/features/members/buddies/buddiesSetup";
import { membersStore, updatePresence, type Member } from "@stores/members.store";
import { channelsStore, setRoles } from "@stores/channels.store";
import { voiceStore } from "@stores/voice.store";
import type { UserStatus } from "@lib/types";
import { makeChannel } from "../helpers/channelFactory";
import { voiceUser } from "../helpers/voiceUsers";

// jsdom lays nothing out, so the Deck rows' fixed heights, which the virtual
// list relies on to leave no gaps, are measured in a real browser.

const MEMBERS = 600;
const LOUNGE = 6;

/** Mixed: in a game, with a custom status, with a song, with nothing, offline. */
function member(id: number): Member {
  const kind = id % 6;
  const status: UserStatus = kind === 5 ? "offline" : kind === 4 ? "idle" : "online";
  return {
    id,
    username: `user${String(id).padStart(4, "0")}`,
    avatar: null,
    role: "member",
    status,
    customStatus: kind === 1 || kind === 5 ? `status ${id}` : null,
    activity: kind === 0 ? { name: `Game ${id}`, startedAt: 1 } : null,
    listening:
      kind === 2
        ? { title: "Song", artist: "Artist", player: "Spotify", startedAt: 1, durationMs: 0 }
        : null,
  };
}

/** Exactly these members are in Lounge. */
function setLounge(ids: readonly number[]): void {
  voiceStore.setState((prev) => ({
    ...prev,
    voiceUsers: new Map([[LOUNGE, new Map(ids.map((id) => [id, voiceUser(id)]))]]),
  }));
  voiceStore.flush();
}

interface Host {
  readonly scroller: HTMLElement;
  readonly list: MemberListComponent;
  readonly root: HTMLElement;
}

const box = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) =>
  Object.assign(document.createElement(tag), { className });

/** The Deck column as the page builds it: aside > body (the scroller) > panel. */
function mountColumn(): Host {
  const column = Object.assign(box("aside", "member-column"), { id: "member-column" });
  column.style.height = "520px";
  const [body, panel] = [box("div", "member-column-body"), box("div", "member-panel")];
  const done = async (): Promise<void> => undefined;
  const list = createMemberList({
    ...buddiesListOptions(),
    currentUserRole: "member",
    onKick: done,
    onBan: () => undefined,
    onChangeRole: done,
    onToggleBlock: done,
  });
  list.mount(panel);
  column.append(body);
  body.append(panel);
  document.body.append(column);
  return { scroller: body, list, root: panel.querySelector<HTMLElement>(".member-list")! };
}

/** Four frames: the scheduled render, its measuring pass and any resize report. */
async function settle(): Promise<void> {
  for (let n = 0; n < 4; n++) await new Promise(requestAnimationFrame);
}

const rows = (root: HTMLElement): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(".buddy-row"),
];
const rowFor = (root: HTMLElement, id: number): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-testid="member-${id}"]`);

/** One height for every drawn row, within 0.5 px; returns it. */
function sameHeight(root: HTMLElement): number {
  const heights = rows(root).map((el) => el.getBoundingClientRect().height);
  expect(heights.length).toBeGreaterThan(5);
  const min = Math.min(...heights);
  expect(Math.max(...heights) - min).toBeLessThanOrEqual(0.5);
  return min;
}

/** No drawn child overlaps the one above it; `contiguous` also allows no gap
 *  beyond a row's 1 px margins (a pinned row far away is a gap). */
function expectNoOverlap(root: HTMLElement, contiguous = false): void {
  const edges = Array.from(root.children, (el) => el.getBoundingClientRect()).sort(
    (a, b) => a.top - b.top,
  );
  expect(edges.length).toBeGreaterThan(1);
  edges.slice(1).forEach((edge, i) => {
    const gap = edge.top - edges[i]!.bottom;
    expect(gap).toBeGreaterThanOrEqual(-0.5);
    if (contiguous) expect(gap).toBeLessThanOrEqual(2.5);
  });
}

let mounted: Host | null = null;

beforeEach(() => {
  document.documentElement.classList.add("layout-deck");
  setRoles([]);
  channelsStore.setState((prev) => ({
    ...prev,
    channels: new Map([[LOUNGE, makeChannel({ id: LOUNGE, name: "Lounge", type: "voice" })]]),
  }));
  channelsStore.flush();
  setLounge(Array.from({ length: MEMBERS / 3 }, (_, i) => i * 3 + 1));
  membersStore.setState((prev) => ({
    ...prev,
    members: new Map(Array.from({ length: MEMBERS }, (_, i) => [i + 1, member(i + 1)])),
  }));
  membersStore.flush();
});

afterEach(() => {
  const html = document.documentElement;
  html.classList.remove("layout-deck");
  html.style.removeProperty("--font-size");
  mounted?.list.destroy?.();
  mounted = null;
  document.body.replaceChildren();
  setLounge([]);
});

describe("Buddies rows in a real layout, above 200 members", () => {
  for (const size of [12, 16, 20]) {
    it(`at ${size} px text every row is max(40, 2.5 x ${size}) px tall`, async () => {
      document.documentElement.style.setProperty("--font-size", `${size}px`);
      const host = (mounted = mountColumn());
      await settle();
      const seen = new Set<string>();
      // Walk the list so the drawn windows cover every row type: a game, a
      // status, a song, nothing, offline, and in a room or out of one.
      for (const at of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
        host.scroller.scrollTop = (host.scroller.scrollHeight - host.scroller.clientHeight) * at;
        await settle();
        for (const row of rows(host.root)) {
          seen.add(row.querySelector(".buddy-line2 > *")?.className ?? "empty line");
          if (row.querySelector(".mi-activity [data-icon='music']") !== null) seen.add("song");
          if (row.classList.contains("offline")) seen.add("offline");
          seen.add(row.querySelector(".buddy-voice:not([hidden])") === null ? "out" : "in room");
        }
        expect(sameHeight(host.root)).toBeCloseTo(Math.max(40, 2.5 * size), 0);
        for (const header of host.root.querySelectorAll(".buddies-group")) {
          expect(header.getBoundingClientRect().height).toBeCloseTo(28, 0);
        }
      }
      expect([...seen].sort()).toEqual(
        [
          "empty line",
          "in room",
          "mi-activity",
          "mi-custom-status",
          "offline",
          "out",
          "song",
        ].sort(),
      );
    });
  }

  it("keeps the height while each patch field turns on and off", async () => {
    document.documentElement.style.setProperty("--font-size", "20px");
    const host = (mounted = mountColumn());
    await settle();
    const expected = sameHeight(host.root);
    // Online with nothing on line 2 and not in a room, so no step rebuilds it;
    // focused, so it stays drawn when it moves to OFFLINE.
    const target = 9;
    host.list.focusMember(target);
    await settle();
    const steps: Array<() => void> = [
      () => setLounge([target]),
      () => setLounge([]),
      () => updatePresence(target, "dnd", undefined, undefined, undefined, undefined, true),
      () => updatePresence(target, "online", undefined, undefined, undefined, undefined, false),
      () => updatePresence(target, "invisible"),
      () => updatePresence(target, "online"),
    ];
    const kept = rowFor(host.root, target);
    expect(kept).not.toBeNull();
    for (const step of steps) {
      step();
      membersStore.flush();
      await settle();
      expect(rowFor(host.root, target)).toBe(kept);
      expect(kept!.getBoundingClientRect().height).toBeCloseTo(expected, 0);
      expect(sameHeight(host.root)).toBeCloseTo(expected, 0);
    }
  });

  it("scrolled to the end, the rows are contiguous", async () => {
    const host = (mounted = mountColumn());
    await settle();
    host.scroller.scrollTop = host.scroller.scrollHeight;
    await settle();
    // The last OFFLINE member by name.
    expect(rowFor(host.root, 599)).not.toBeNull();
    expectNoOverlap(host.root, true);
    sameHeight(host.root);
  });

  it("the focused member keeps focus while moving group", async () => {
    const host = (mounted = mountColumn());
    await settle();
    const row = rowFor(host.root, 6)!;
    row.focus();
    host.scroller.scrollTop = host.scroller.scrollHeight;
    await settle();
    expect(document.activeElement).toBe(row);

    // Stopping the game rebuilds the row (line 2 changes) and moves it to ONLINE.
    updatePresence(6, "online", undefined, undefined, null);
    membersStore.flush();
    await settle();
    const moved = rowFor(host.root, 6);
    expect(moved).not.toBeNull();
    expect(document.activeElement).toBe(moved);
    expect(moved!.querySelector(".buddy-line2")?.childElementCount).toBe(0);

    // A status change alone keeps the element, now in DO NOT DISTURB.
    updatePresence(6, "dnd");
    membersStore.flush();
    await settle();
    expect(rowFor(host.root, 6)).toBe(moved);
    expect(document.activeElement).toBe(moved);
    expectNoOverlap(host.root);
  });
});
