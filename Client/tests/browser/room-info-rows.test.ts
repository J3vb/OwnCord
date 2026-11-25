import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
// Same stylesheet order as main.ts: tokens, the border-box reset, then app.
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";
import "../../src/styles/app.css";
import { createRoomInfoPanel, type RoomInfoPanel } from "../../src/features/deck/roomInfoPanel";
import { liveStatsStore, writeLiveStats } from "../../src/lib/voice/liveStats";
import type { ConnectionStats, QualityLevel } from "../../src/lib/voice/connectionStats";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import {
  voiceStore,
  type PeerVerification,
  type VoiceStatus,
  type VoiceUser,
} from "@stores/voice.store";
import { makeChannel } from "../helpers/channelFactory";
import { voiceUser } from "../helpers/voiceUsers";
import { statsSample } from "../helpers/connectionStatsSample";

// jsdom lays nothing out, so the Info block's fixed heights, and the rule that
// a never-cut word stays whole while the label column gives way, are measured
// in a real browser with the real panel, fed by store writes.

const ME = 1;
const LOUNGE = 6;
const LONG_NAME = "A".repeat(32);

/** The Sizes table: 1 px border + 32 px header + five rows + 8 px of padding. */
const FULL_HEIGHT: Record<number, number> = { 12: 151, 16: 151, 20: 178.5 };

const SECURITY_CASES: ReadonlyArray<{
  readonly word: string;
  readonly status: VoiceStatus;
  readonly degraded?: boolean;
  readonly peer?: PeerVerification["status"];
}> = [
  { word: "Unsecured", status: "connected", degraded: true },
  { word: "Reconnecting…", status: "reconnecting" },
  { word: "Connecting…", status: "joining" },
  { word: "Securing…", status: "securing" },
  { word: "Blocked", status: "connected", peer: "mismatch" },
  { word: "New key", status: "connected", peer: "changed" },
  { word: "No key", status: "connected", peer: "unverified" },
  { word: "Secured", status: "connected" },
];
const QUALITY_CASES: ReadonlyArray<readonly [QualityLevel, string]> = [
  ["excellent", "Good"],
  ["fair", "Fair"],
  ["poor", "Poor"],
  ["bad", "Bad"],
];

const sample = statsSample;

function setRoom(
  users: readonly VoiceUser[],
  over: Partial<Parameters<typeof makeChannel>[0]> = {},
) {
  channelsStore.setState((prev) => ({
    ...prev,
    channels: new Map([
      [
        LOUNGE,
        makeChannel({ id: LOUNGE, name: "Lounge", type: "voice", voiceMaxUsers: 8, ...over }),
      ],
    ]),
  }));
  channelsStore.flush();
  voiceStore.setState((prev) => ({
    ...prev,
    voiceUsers: new Map([[LOUNGE, new Map(users.map((u) => [u.userId, u]))]]),
  }));
  voiceStore.flush();
}

function setMediumConfig(): void {
  const config = {
    quality: "medium",
    bitrate: 64_000,
    threshold_mode: "auto",
    mixing_threshold: 0,
    top_speakers: 0,
    max_users: 0,
  };
  voiceStore.setState((prev) => ({ ...prev, voiceConfigs: new Map([[LOUNGE, config]]) }));
  voiceStore.flush();
}

function setSecurity(c: (typeof SECURITY_CASES)[number]): void {
  voiceStore.setState((prev) => ({
    ...prev,
    voiceStatus: c.status,
    encryptionDegraded: c.degraded === true,
    peerVerifications:
      c.peer === undefined
        ? new Map()
        : new Map([
            [2, { userId: 2, status: c.peer, safetyNumber: null, sessionFingerprint: null }],
          ]),
  }));
  voiceStore.flush();
}

function setQuality(partial: Partial<ConnectionStats>): void {
  writeLiveStats(sample(partial), true);
  liveStatsStore.flush();
}

let panel: RoomInfoPanel | null = null;
let column: HTMLElement;

/** The Deck column as the page builds it: aside > body (the scroller), then Info. */
function mount(width: number): HTMLElement {
  column = Object.assign(document.createElement("aside"), {
    id: "member-column",
    className: "member-column",
  });
  column.style.width = `${width}px`;
  column.style.height = "520px";
  const body = Object.assign(document.createElement("div"), { className: "member-column-body" });
  panel = createRoomInfoPanel();
  column.append(body, panel.element);
  document.body.append(column);
  return panel.element;
}

function textSize(px: number): void {
  document.documentElement.style.setProperty("--font-size", `${px}px`);
}

const ddOf = (el: HTMLElement, name: string): HTMLElement =>
  el.querySelector<HTMLElement>(`[data-testid="room-info-${name}"] > dd`)!;
const wordOf = (dd: HTMLElement): HTMLElement => dd.querySelector<HTMLElement>(".room-info-word")!;

/** The word is drawn whole, inside its box. */
function expectWhole(word: HTMLElement, box: HTMLElement, label: string): void {
  expect(word.hidden, label).toBe(false);
  expect(word.scrollWidth, label).toBeLessThanOrEqual(word.clientWidth);
  expect(word.getBoundingClientRect().right, label).toBeLessThanOrEqual(
    box.getBoundingClientRect().right + 0.5,
  );
  expect(word.getBoundingClientRect().width, label).toBeGreaterThan(0);
}

beforeEach(async () => {
  await page.viewport(1333, 900);
  document.documentElement.classList.add("layout-deck");
  authStore.setState((prev) => ({
    ...prev,
    user: { id: ME, username: "me", role: "member", avatar: null, totp_enabled: false },
  }));
  authStore.flush();
  voiceStore.setState((prev) => ({
    ...prev,
    currentChannelId: LOUNGE,
    voiceStatus: "connected",
    encryptionDegraded: false,
    peerVerifications: new Map(),
    joinedAt: Date.now() - 1_000,
  }));
  setRoom([voiceUser(ME), voiceUser(2, { username: "Rin", screenshare: true }), voiceUser(3)]);
});

afterEach(() => {
  panel?.destroy();
  panel = null;
  const html = document.documentElement;
  html.classList.remove("layout-deck");
  html.style.removeProperty("--font-size");
  document.body.replaceChildren();
  voiceStore.setState((prev) => ({ ...prev, currentChannelId: null, voiceUsers: new Map() }));
  voiceStore.flush();
  liveStatsStore.setState(() => ({ stats: null, at: 0, connected: false }));
  liveStatsStore.flush();
});

describe("room Info: heights (real layout)", () => {
  it.each([12, 16, 20])(
    "at %i px text the full form is the Sizes table's height, before and after long values",
    (px) => {
      textSize(px);
      const el = mount(240);
      const summary = el.querySelector<HTMLElement>(".room-info-summary")!;
      expect(getComputedStyle(summary).display).toBe("none");
      expect(Math.abs(el.getBoundingClientRect().height - FULL_HEIGHT[px]!)).toBeLessThanOrEqual(
        0.5,
      );

      setRoom(
        [
          voiceUser(ME, { camera: true }),
          voiceUser(2, { username: LONG_NAME, screenshare: true }),
          voiceUser(3, { username: `${LONG_NAME}B`, camera: true }),
        ],
        { name: `${LONG_NAME} room with a long name`, voiceMaxUsers: 99 },
      );
      setMediumConfig();
      setSecurity({ word: "Blocked", status: "connected", peer: "mismatch" });
      setQuality({ rtt: 1234.5, loss: 12.3, quality: "bad" });
      expect(Math.abs(el.getBoundingClientRect().height - FULL_HEIGHT[px]!)).toBeLessThanOrEqual(
        0.5,
      );
    },
  );
});

describe("room Info: never-cut words (real layout)", () => {
  it.each([200, 240, 280, 360])(
    "at a %i px column every Security and Quality word stays whole at 12, 16 and 20 px text",
    (width) => {
      const el = mount(width);
      const security = ddOf(el, "security");
      const quality = ddOf(el, "quality");
      for (const px of [12, 16, 20]) {
        textSize(px);
        for (const c of SECURITY_CASES) {
          setSecurity(c);
          expect(wordOf(security).textContent).toBe(c.word);
          expectWhole(wordOf(security), security, `${c.word} at ${width}px, ${px}px text`);
        }
        setSecurity({ word: "Secured", status: "connected" });
        for (const [level, word] of QUALITY_CASES) {
          setQuality({ quality: level, rtt: 18, loss: 3.4 });
          expect(wordOf(quality).textContent).toBe(word);
          expectWhole(wordOf(quality), quality, `${word} at ${width}px, ${px}px text`);
        }
      }
    },
  );

  it("a 32-character stream name and Medium · 64 kbps at a 200 px column and 20 px text are cut, not the labels", () => {
    textSize(20);
    const el = mount(200);
    const labelWidth = (): number =>
      el
        .querySelector<HTMLElement>('[data-testid="room-info-streams"] > dt')!
        .getBoundingClientRect().width;
    const short = labelWidth();

    setRoom([voiceUser(ME), voiceUser(2, { username: LONG_NAME, screenshare: true })]);
    setMediumConfig();

    expect(labelWidth()).toBeGreaterThanOrEqual(short - 0.5);
    const streams = ddOf(el, "streams").querySelector<HTMLElement>(".room-info-detail")!;
    expect(streams.textContent).toBe(`${LONG_NAME} · screen`);
    expect(streams.scrollWidth).toBeGreaterThan(streams.clientWidth);
    expect(getComputedStyle(streams).textOverflow).toBe("ellipsis");
    const audio = ddOf(el, "audio").querySelector<HTMLElement>(".room-info-detail")!;
    expect(audio.textContent).toBe("Medium · 64 kbps");
    expect(audio.getBoundingClientRect().right).toBeLessThanOrEqual(
      ddOf(el, "audio").getBoundingClientRect().right + 0.5,
    );
    expect(getComputedStyle(audio).textOverflow).toBe("ellipsis");
  });
});

describe("room Info: the short-window form (real layout)", () => {
  it("at 1333x600 shows the compact form, 63 px tall at 16 px text", async () => {
    await page.viewport(1333, 600);
    textSize(16);
    const el = mount(240);
    const rows = el.querySelector<HTMLElement>(".room-info-rows")!;
    const summary = el.querySelector<HTMLElement>(".room-info-summary")!;
    expect(getComputedStyle(rows).display).toBe("none");
    expect(getComputedStyle(summary).display).toBe("flex");
    // The prefix leaves the screen but stays in the title, so the region keeps its name.
    const prefix = el.querySelector<HTMLElement>(".room-info-prefix")!;
    expect(getComputedStyle(prefix).display).not.toBe("none");
    expect(getComputedStyle(prefix).position).toBe("absolute");
    expect(getComputedStyle(prefix).clip).toBe("rect(0px, 0px, 0px, 0px)");
    // Out of flow: the room name starts where the title does.
    const title = el.querySelector<HTMLElement>("#room-info-title")!;
    const room = el.querySelector<HTMLElement>(".room-info-room")!;
    expect(room.getBoundingClientRect().left).toBe(title.getBoundingClientRect().left);
    expect(el.querySelector("#room-info-title")!.textContent).toBe("Info · Lounge");
    expect(Math.abs(el.getBoundingClientRect().height - 63)).toBeLessThanOrEqual(0.5);
  });

  it("with Blocked at a 200 px column and 20 px text keeps the word whole and cuts the ping first", async () => {
    await page.viewport(1333, 600);
    textSize(20);
    const el = mount(200);
    setSecurity({ word: "Blocked", status: "connected", peer: "mismatch" });
    setQuality({ rtt: 123456 });
    const summary = el.querySelector<HTMLElement>(".room-info-summary")!;
    const word = summary.querySelector<HTMLElement>(".room-info-sum-security .room-info-word")!;
    const ping = summary.querySelector<HTMLElement>(".room-info-sum-ping")!;
    expect(word.textContent).toBe("Blocked");
    expect(ping.textContent).toBe("123,456 ms");
    expectWhole(word, summary, "Blocked in the summary");
    expect(ping.scrollWidth).toBeGreaterThan(ping.clientWidth);
    expect(Math.abs(el.getBoundingClientRect().height - 68.5)).toBeLessThanOrEqual(0.5);
  });

  it("at 1333x601 it is the full form", async () => {
    await page.viewport(1333, 601);
    textSize(16);
    const el = mount(240);
    expect(getComputedStyle(el.querySelector(".room-info-rows")!).display).toBe("grid");
    expect(getComputedStyle(el.querySelector(".room-info-summary")!).display).toBe("none");
    expect(Math.abs(el.getBoundingClientRect().height - 151)).toBeLessThanOrEqual(0.5);
  });
});
