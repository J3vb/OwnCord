/**
 * Listening to a shared music track: the store field, the call view's music
 * tile, the sidebar's Listen pill and the voice widget's listening bar.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "../helpers/resizeObserverStub";
import * as voiceSession from "../helpers/voiceSessionMock";

const mockListen = vi.fn();
const mockMusicVolume = vi.fn((_userId: number) => 70);
const mockSetMusicVolume = vi.fn();
vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({
    listenToMusic: (userId: number | null) => mockListen(userId),
    getMusicVolume: (userId: number) => mockMusicVolume(userId),
    setMusicVolume: (userId: number, percent: number) => mockSetMusicVolume(userId, percent),
  }),
);

import { makeVoiceUser as user } from "../helpers/voiceUsers";
import { createVideoGrid } from "../../src/features/voice/videoGrid/VideoGrid";
import type { GridMusic } from "../../src/features/voice/videoGrid/VideoGrid";
import { createListeningBar } from "../../src/features/voice/widget/listeningBar";
import {
  voiceUserModel,
  type VoiceRowInputs,
  type VoiceUserContext,
} from "../../src/features/channels/voiceRowModel";
import { drawVoiceUserRow } from "../../src/features/channels/voiceRow.view";
import { createAvatarElement } from "../../src/features/profiles/avatar";
import { voiceStore, resetVoiceStore, leaveVoiceChannel } from "../../src/stores/voice.store";
import { withListeningTo } from "../../src/stores/voicePeers";
import { USER_VOLUME_CHANGED } from "../../src/lib/constants";

const SELF = 1;
const SAM = 2;

const setListeningTo = (userId: number | null): void =>
  voiceStore.setState((prev) => withListeningTo(prev, userId));

beforeEach(() => {
  vi.clearAllMocks();
  resetVoiceStore();
});

describe("voice store listeningTo", () => {
  it("starts empty, is set and cleared, and notifies only on a change", () => {
    expect(voiceStore.getState().listeningTo).toBeNull();
    const seen = vi.fn();
    const unsubscribe = voiceStore.subscribe(seen);

    setListeningTo(SAM);
    setListeningTo(SAM);
    expect(voiceStore.getState().listeningTo).toBe(SAM);
    setListeningTo(null);
    voiceStore.flush();
    unsubscribe();

    expect(voiceStore.getState().listeningTo).toBeNull();
    expect(seen.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("is reset when you leave the channel, and on a store reset", () => {
    setListeningTo(SAM);
    leaveVoiceChannel();
    expect(voiceStore.getState().listeningTo).toBeNull();

    setListeningTo(SAM);
    resetVoiceStore();
    expect(voiceStore.getState().listeningTo).toBeNull();
  });
});

const music = (over: Partial<GridMusic> = {}): GridMusic => ({
  userId: SAM,
  name: "Sam",
  listening: false,
  volume: 70,
  onListen: vi.fn(),
  onStop: vi.fn(),
  onVolume: vi.fn(),
  ...over,
});

describe("music tile in the video grid", () => {
  let container: HTMLDivElement;
  let grid: ReturnType<typeof createVideoGrid>;

  beforeEach(() => {
    container = document.createElement("div");
    grid = createVideoGrid();
    grid.mount(container);
  });
  afterEach(() => grid.destroy?.());

  const cell = (id = SAM) => container.querySelector<HTMLElement>(`[data-music-id='${id}']`);

  it("shows a tile with no camera or share in the call, offering Listen to music", () => {
    const tile = music();
    grid.setMusic([tile]);

    expect(grid.hasStreams()).toBe(false);
    expect(cell()?.textContent).toContain("Sam is sharing music");
    const button = cell()!.querySelector<HTMLButtonElement>("[data-music-control='listen']")!;
    expect(button.textContent).toContain("Listen to music");
    expect(cell()!.querySelector(".tile-volume-slider")).toBeNull();
    button.click();
    expect(tile.onListen).toHaveBeenCalledTimes(1);
  });

  it("names the sharer in the tag, with the note", () => {
    grid.setMusic([music()]);
    const tag = cell()!.querySelector(".video-label .video-username")!;
    expect(tag.textContent).toBe("Sam");
    expect(tag.querySelector("svg")).not.toBeNull();
  });

  it("while listening shows the volume bound to Music volume and Stop listening", () => {
    const tile = music({ listening: true });
    grid.setMusic([tile]);

    const slider = cell()!.querySelector<HTMLInputElement>(".tile-volume-slider")!;
    expect(slider.value).toBe("70");
    slider.value = "35";
    slider.dispatchEvent(new Event("input"));
    expect(tile.onVolume).toHaveBeenCalledWith(35);
    expect(cell()!.querySelector(".tile-volume-value")!.textContent).toBe("35%");

    cell()!.querySelector<HTMLButtonElement>("[data-music-control='stop']")!.click();
    expect(tile.onStop).toHaveBeenCalledTimes(1);
    expect(cell()!.textContent).toContain("Listening to Sam");
  });

  it("redraws on listen and keeps the cell, and removes it when the sharer stops", () => {
    grid.setMusic([music()]);
    const before = cell();
    grid.setMusic([music({ listening: true })]);
    expect(cell()).toBe(before);
    expect(cell()!.classList.contains("video-cell--listening")).toBe(true);

    grid.setMusic([]);
    expect(cell()).toBeNull();
  });

  it("does not redraw (and so does not drop a dragged slider) when nothing it shows changed", () => {
    grid.setMusic([music({ listening: true })]);
    const slider = cell()!.querySelector(".tile-volume-slider");
    grid.setMusic([music({ listening: true })]);
    expect(cell()!.querySelector(".tile-volume-slider")).toBe(slider);
  });

  it("keeps a tile per sharer", () => {
    grid.setMusic([music(), music({ userId: 3, name: "Alex" })]);
    expect(container.querySelectorAll(".video-cell--music")).toHaveLength(2);
  });
});

const snap = (over: Partial<VoiceRowInputs> = {}): VoiceRowInputs => ({
  voiceUsers: new Map([
    [
      10,
      new Map([
        [SELF, user(SELF)],
        [SAM, user(SAM)],
      ]),
    ],
  ]),
  currentChannelId: 10,
  peerVerifications: new Map(),
  localSessionFingerprint: null,
  localSafetyNumber: null,
  voiceMembers: new Map(),
  selfId: SELF,
  connectionStatus: "connected",
  timeout: null,
  movable: [],
  localMute: {},
  musicSharers: new Set([SELF, SAM]),
  ...over,
});

describe("Listen pill on a sidebar row", () => {
  const ctx: VoiceUserContext = {
    avatarColor: () => "#5865f2",
    localSilenced: () => false,
    moderation: false,
  };
  const pill = (inputs: VoiceRowInputs, userId = SAM, channelId = 10) =>
    drawVoiceUserRow(
      voiceUserModel(user(userId), channelId, inputs, ctx),
      createAvatarElement,
    ).querySelector<HTMLElement>(".vu-listen");

  it("offers Listen for a remote sharer in your channel", () => {
    const el = pill(snap())!;
    expect(el.textContent).toBe("Listen");
    expect(el.getAttribute("aria-pressed")).toBe("false");
    expect(el.classList.contains("vu-listen--on")).toBe(false);
  });

  it("reads Listening, green, while you listen to them", () => {
    const el = pill(snap({ listeningTo: SAM }))!;
    expect(el.textContent).toBe("Listening");
    expect(el.getAttribute("aria-pressed")).toBe("true");
    expect(el.classList.contains("vu-listen--on")).toBe(true);
  });

  it("is not drawn for yourself, for a non-sharer, or for a channel you are not in", () => {
    expect(pill(snap(), SELF)).toBeNull();
    expect(pill(snap({ musicSharers: new Set([SELF]) }))).toBeNull();
    expect(pill(snap({ currentChannelId: 11 }))).toBeNull();
    expect(pill(snap({ currentChannelId: null }))).toBeNull();
  });

  it("follows the note in the row", () => {
    const row = drawVoiceUserRow(voiceUserModel(user(SAM), 10, snap(), ctx), createAvatarElement);
    expect(row.querySelector(".vu-music + .vu-listen")).not.toBeNull();
  });
});

const sync = () => voiceStore.getState();

describe("voice widget listening bar", () => {
  it("is hidden until you listen, then names the sharer, the level and offers Stop", () => {
    const ac = new AbortController();
    const bar = createListeningBar(ac.signal, vi.fn());
    document.body.appendChild(bar.el);
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 10,
      voiceUsers: new Map([[10, new Map([[SAM, user(SAM, { username: "Sam" })]])]]),
    }));
    bar.sync(sync());
    expect(bar.el.hidden).toBe(true);

    setListeningTo(SAM);
    bar.sync(sync());

    expect(bar.el.hidden).toBe(false);
    expect(bar.el.textContent).toContain("Listening to Sam");
    expect(bar.el.textContent).toContain("Music · 70%");
    bar.el.querySelector<HTMLButtonElement>("[data-testid='vw-listening-stop']")!.click();
    expect(mockListen).toHaveBeenCalledWith(null);

    setListeningTo(null);
    bar.sync(sync());
    expect(bar.el.hidden).toBe(true);
    ac.abort();
    bar.el.remove();
  });

  it("asks to redraw when a Music volume changes, until its signal aborts", () => {
    const ac = new AbortController();
    const redraw = vi.fn();
    createListeningBar(ac.signal, redraw);

    window.dispatchEvent(new CustomEvent(USER_VOLUME_CHANGED));
    expect(redraw).toHaveBeenCalledTimes(1);
    ac.abort();
    window.dispatchEvent(new CustomEvent(USER_VOLUME_CHANGED));
    expect(redraw).toHaveBeenCalledTimes(1);
  });
});
