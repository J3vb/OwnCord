// The room Info panel: its DOM, its two selections and what each one patches.
// jsdom lays nothing out; the sizes are measured in tests/browser/room-info-rows.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoomInfoPanel, type RoomInfoPanel } from "../../../src/features/deck/roomInfoPanel";
import type { ConnectionStats } from "../../../src/lib/voice/connectionStats";
import { liveStatsStore, writeLiveStats } from "../../../src/lib/voice/liveStats";
import { channelsStore } from "../../../src/stores/channels.store";
import {
  setPeerVerification,
  voiceStore,
  type VoiceStatus,
  type VoiceUser,
} from "../../../src/stores/voice.store";
import { makeChannel } from "../../helpers/channelFactory";
import { resetVoiceState, signInAsAdmin } from "../../helpers/storeSeeds";
import { voiceUser } from "../../helpers/voiceUsers";
import { statsSample } from "../../helpers/connectionStatsSample";

const ME = 1;
const LOUNGE = 10;
const HALL = 11;

const sample = statsSample;

function roster(...list: VoiceUser[]): Map<number, Map<number, VoiceUser>> {
  return new Map([[LOUNGE, new Map(list.map((u) => [u.userId, u]))]]);
}

const ROSTER = (): Map<number, Map<number, VoiceUser>> =>
  roster(
    voiceUser(ME, { username: "me" }),
    voiceUser(2, { username: "Rin", screenshare: true }),
    voiceUser(3, { username: "Marco" }),
  );

function setVoice(patch: Parameters<typeof voiceStore.setState>[0]): void {
  voiceStore.setState(patch);
  voiceStore.flush();
}

const status = (voiceStatus: VoiceStatus): void => setVoice((p) => ({ ...p, voiceStatus }));

function writeSample(partial: Partial<ConnectionStats> = {}): void {
  writeLiveStats(sample(partial), true);
  liveStatsStore.flush();
}

let panel: RoomInfoPanel | null = null;

function mount(): HTMLElement {
  panel = createRoomInfoPanel();
  document.body.appendChild(panel.element);
  return panel.element;
}

const q = (root: Element, selector: string): HTMLElement => {
  const el = root.querySelector<HTMLElement>(selector);
  if (el === null) throw new Error(`no ${selector}`);
  return el;
};
const row = (root: Element, name: string): HTMLElement =>
  q(root, `[data-testid="room-info-${name}"]`);
/** The drawn text of a value or summary: everything but its sr-only parts, hidden parts left out. */
function drawn(el: Element): string {
  let out = "";
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) out += child.textContent ?? "";
    else if (child instanceof HTMLElement && !child.hidden && !child.classList.contains("sr-only"))
      out += drawn(child);
  }
  return out;
}
const spoken = (el: Element): string[] =>
  [...el.querySelectorAll(".sr-only")].map((s) => s.textContent ?? "");

beforeEach(() => {
  signInAsAdmin("me");
  channelsStore.setState((p) => ({
    ...p,
    channels: new Map([
      [LOUNGE, makeChannel({ id: LOUNGE, name: "Lounge", type: "voice", voiceMaxUsers: 8 })],
      [HALL, makeChannel({ id: HALL, name: "Hall", type: "voice" })],
    ]),
  }));
  channelsStore.flush();
  resetVoiceState({
    currentChannelId: LOUNGE,
    voiceUsers: ROSTER(),
    voiceStatus: "connected",
    joinedAt: Date.now() - 1_000,
  });
  voiceStore.flush();
  liveStatsStore.setState(() => ({ stats: null, at: 0, connected: false }));
  liveStatsStore.flush();
});

afterEach(() => {
  panel?.destroy();
  panel?.element.remove();
  panel = null;
  vi.useRealTimers();
  resetVoiceState();
  voiceStore.flush();
});

describe("roomInfoPanel: DOM", () => {
  it("builds the named markup", () => {
    const el = mount();
    expect(el.tagName).toBe("SECTION");
    expect(el.className).toBe("room-info");
    expect(el.dataset["testid"]).toBe("room-info");
    expect(el.getAttribute("aria-labelledby")).toBe("room-info-title");
    expect(el.hasAttribute("aria-live")).toBe(false);

    const head = q(el, ":scope > .room-info-head");
    const light = q(head, ":scope > span.room-info-light");
    expect(light.getAttribute("aria-hidden")).toBe("true");
    expect(light.dataset["level"]).toBe("ok");
    const title = q(head, ":scope > h2#room-info-title.room-info-title");
    expect(q(title, ":scope > span.room-info-prefix").textContent).toBe("Info · ");
    expect(q(title, ":scope > span.room-info-room").textContent).toBe("Lounge");

    const dl = q(el, ":scope > dl.room-info-rows");
    const rows = [...dl.children];
    expect(rows.map((r) => (r as HTMLElement).dataset["testid"])).toEqual([
      "room-info-users",
      "room-info-audio",
      "room-info-security",
      "room-info-quality",
      "room-info-streams",
    ]);
    for (const r of rows) {
      expect(r.className).toBe("room-info-row");
      expect(r.children[0]!.tagName).toBe("DT");
      expect(r.children[0]!.firstElementChild!.className).toBe("room-info-label");
      expect(r.children[1]!.tagName).toBe("DD");
    }
    expect(rows.map((r) => r.querySelector(".room-info-label")!.textContent)).toEqual([
      "Users",
      "Audio",
      "Security",
      "Quality",
      "Streams",
    ]);

    const summary = q(el, ":scope > p.room-info-summary");
    expect(summary.dataset["testid"]).toBe("room-info-summary");
    expect(summary.previousElementSibling).toBe(dl);
    expect(el.querySelectorAll("[tabindex], button, a, input")).toHaveLength(0);
  });

  it("draws every value at creation, before any store change", () => {
    const el = mount();
    expect(el.hidden).toBe(false);
    expect(drawn(row(el, "users").querySelector("dd")!)).toBe("3 / 8");
    expect(drawn(row(el, "audio").querySelector("dd")!)).toBe("Not known");
    expect(drawn(row(el, "security").querySelector("dd")!)).toBe("Secured");
    expect(drawn(row(el, "quality").querySelector("dd")!)).toBe("Not measured");
    expect(drawn(row(el, "streams").querySelector("dd")!)).toBe("Rin · screen");
    expect(drawn(q(el, ".room-info-summary"))).toBe("3/8 · Secured");
    expect(spoken(q(el, ".room-info-summary"))).toEqual([
      "In the room: 3 of 8.",
      "Secured",
      "Not measured",
    ]);
  });

  it("marks the muted values, and draws no dot for Not measured", () => {
    const el = mount();
    expect(q(row(el, "audio"), ".room-info-detail").classList.contains("room-info-muted")).toBe(
      true,
    );
    const quality = row(el, "quality");
    expect(q(quality, ".room-info-detail").classList.contains("room-info-muted")).toBe(true);
    expect(q(quality, ".room-info-dot").hidden).toBe(true);
    expect(q(row(el, "security"), ".room-info-dot").hidden).toBe(false);
    expect(q(row(el, "streams"), ".room-info-detail").classList.contains("room-info-muted")).toBe(
      false,
    );
  });

  it("is hidden with no room, and shows again on a join", () => {
    resetVoiceState();
    voiceStore.flush();
    const el = mount();
    expect(el.hidden).toBe(true);
    setVoice((p) => ({ ...p, currentChannelId: LOUNGE, voiceUsers: ROSTER() }));
    expect(el.hidden).toBe(false);
    setVoice((p) => ({ ...p, currentChannelId: null }));
    expect(el.hidden).toBe(true);
  });
});

describe("roomInfoPanel: patches", () => {
  it("a model change patches the same elements", () => {
    const el = mount();
    const word = q(row(el, "security"), ".room-info-word");
    const roomName = q(el, ".room-info-room");
    setVoice((p) => ({
      ...p,
      currentChannelId: HALL,
      voiceUsers: new Map([[HALL, new Map([[ME, voiceUser(ME)]])]]),
      voiceStatus: "joining",
    }));
    expect(q(row(el, "security"), ".room-info-word")).toBe(word);
    expect(q(el, ".room-info-room")).toBe(roomName);
    expect(word.textContent).toBe("Connecting…");
    expect(roomName.textContent).toBe("Hall");
    expect(drawn(row(el, "users").querySelector("dd")!)).toBe("1");
    expect(q(el, ".room-info-light").dataset["level"]).toBe("warn");
  });

  it("a speaking change does not touch the DOM", () => {
    const el = mount();
    const observer = new MutationObserver(() => undefined);
    observer.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
    setVoice((p) => ({
      ...p,
      voiceUsers: roster(
        voiceUser(ME, { username: "me", speaking: true, muted: true }),
        voiceUser(2, { username: "Rin", screenshare: true, speaking: true }),
        voiceUser(3, { username: "Marco", deafened: true }),
      ),
    }));
    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
  });

  it("a sample patches only the Quality value and the summary's ping parts", () => {
    const el = mount();
    const qualityDd = row(el, "quality").querySelector("dd")!;
    const ping = q(el, ".room-info-sum-ping");
    const pingSr = ping.nextElementSibling!;
    const sep = ping.previousElementSibling!;
    const observer = new MutationObserver(() => undefined);
    observer.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });

    writeSample({ rtt: 18.2, loss: 3.4 });

    const records = observer.takeRecords();
    observer.disconnect();
    expect(records.length).toBeGreaterThan(0);
    const allowed = [qualityDd, ping, pingSr, sep];
    for (const r of records) {
      const target = r.target instanceof Element ? r.target : r.target.parentElement!;
      expect(allowed.some((a) => a.contains(target))).toBe(true);
    }
    expect(drawn(qualityDd)).toBe("Good · 18 ms · 3% loss");
    expect(q(qualityDd, ".room-info-dot").hidden).toBe(false);
    expect(q(qualityDd, ".room-info-dot").dataset["level"]).toBe("ok");
    expect(q(qualityDd, ".sr-only").textContent).toBe("Good · 18 ms · 3% loss");
    expect(drawn(q(el, ".room-info-summary"))).toBe("3/8 · Secured · 18 ms");
    expect(pingSr.textContent).toBe("Good · 18 ms · 3% loss");
  });

  it("a sample written before the current join, or while not connected, stays hidden", () => {
    const el = mount();
    writeLiveStats(sample(), false);
    liveStatsStore.flush();
    expect(drawn(row(el, "quality").querySelector("dd")!)).toBe("Not measured");
    setVoice((p) => ({ ...p, joinedAt: Date.now() + 60_000 }));
    writeSample();
    expect(drawn(row(el, "quality").querySelector("dd")!)).toBe("Not measured");
  });

  it("a status change to joining shows Not measured and drops the summary's ping and its separator", () => {
    const el = mount();
    writeSample();
    const ping = q(el, ".room-info-sum-ping");
    expect(ping.textContent).toBe("18 ms");
    status("joining");
    expect(drawn(row(el, "quality").querySelector("dd")!)).toBe("Not measured");
    expect(ping.textContent).toBe("");
    expect((ping.previousElementSibling as HTMLElement).hidden).toBe(true);
    expect(drawn(q(el, ".room-info-summary"))).toBe("3/8 · Connecting…");
  });
});

describe("roomInfoPanel: screen-reader parts", () => {
  it("hides every drawn summary part and puts each sr-only part right after its own span", () => {
    const el = mount();
    writeSample();
    const summary = q(el, ".room-info-summary");
    for (const child of summary.children) {
      if (child.classList.contains("sr-only")) continue;
      expect(child.getAttribute("aria-hidden"), child.className).toBe("true");
    }
    for (const name of ["users", "security", "ping"]) {
      const span = q(summary, `.room-info-sum-${name}`);
      expect(span.nextElementSibling!.className).toBe("sr-only");
    }
    expect(spoken(summary)).toEqual(["In the room: 3 of 8.", "Secured", "Good · 18 ms"]);
  });

  it("puts no sr-only text inside an aria-hidden element, anywhere in the panel", () => {
    const el = mount();
    writeSample();
    setPeerVerification({
      userId: 2,
      status: "changed",
      safetyNumber: null,
      sessionFingerprint: null,
    });
    voiceStore.flush();
    const srOnly = [...el.querySelectorAll(".sr-only")];
    expect(srOnly.length).toBeGreaterThanOrEqual(6);
    for (const sr of srOnly) expect(sr.closest('[aria-hidden="true"]')).toBeNull();
    for (const name of ["security", "quality", "streams"]) {
      const dd = row(el, name).querySelector("dd")!;
      const last = dd.lastElementChild!;
      expect(last.className).toBe("sr-only");
      for (const part of dd.children) {
        if (part !== last) expect(part.getAttribute("aria-hidden")).toBe("true");
      }
    }
    expect(q(row(el, "security"), ".sr-only").textContent).toBe(
      "New key. 1 participant with a new key.",
    );
    expect(q(row(el, "streams"), ".sr-only").textContent).toBe("Rin · screen");
  });

  it("a key notice in a short window: the summary says Blocked, never Secured, with no dangling separator", () => {
    const el = mount();
    setPeerVerification({
      userId: 2,
      status: "mismatch",
      safetyNumber: null,
      sessionFingerprint: null,
    });
    voiceStore.flush();
    const summary = q(el, ".room-info-summary");
    expect(drawn(summary)).toBe("3/8 · Blocked");
    expect(q(summary, ".room-info-sum-security .room-info-dot").dataset["level"]).toBe("bad");
    expect(q(el, ".room-info-light").dataset["level"]).toBe("bad");
    const securitySr = q(summary, ".room-info-sum-security").nextElementSibling!.textContent!;
    expect(securitySr).toContain("key does not match");
    expect(securitySr).not.toContain("Secured");
    for (const text of spoken(el)) expect(text).not.toContain("Secured");
    expect(q(row(el, "security"), ".room-info-word").textContent).toBe("Blocked");
    expect(q(row(el, "security"), ".room-info-detail").textContent).toBe("(1)");
    // No ping: the separator before it is hidden.
    expect((q(summary, ".room-info-sum-ping").previousElementSibling as HTMLElement).hidden).toBe(
      true,
    );
  });
});

describe("roomInfoPanel: safety and lifetime", () => {
  it("draws names as text", () => {
    const evil = "<img src=x onerror=1>";
    channelsStore.setState((p) => ({
      ...p,
      channels: new Map([[LOUNGE, makeChannel({ id: LOUNGE, name: evil, type: "voice" })]]),
    }));
    channelsStore.flush();
    setVoice((p) => ({
      ...p,
      voiceUsers: roster(voiceUser(ME), voiceUser(2, { username: evil, camera: true })),
    }));
    const el = mount();
    expect(el.querySelector("img")).toBeNull();
    expect(q(el, ".room-info-room").textContent).toBe(evil);
    expect(q(row(el, "streams"), ".room-info-detail").textContent).toBe(`${evil} · camera`);
  });

  it("starts no timer, and after destroy a store change calls nothing", () => {
    vi.useFakeTimers();
    const el = mount();
    expect(vi.getTimerCount()).toBe(0);
    panel!.destroy();
    const observer = new MutationObserver(() => undefined);
    observer.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
    status("reconnecting");
    writeSample();
    setVoice((p) => ({ ...p, currentChannelId: null }));
    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });
});
