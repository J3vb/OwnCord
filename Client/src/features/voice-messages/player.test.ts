import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "@lib/types";
import { runSessionResets } from "@lib/sessionRegistry";
import { encodeWaveform } from "./waveform";
import { isVoiceAttachment, renderVoicePlayer, type VoiceAttachment } from "./player";

const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 4) % 256);

function voiceAtt(overrides: Partial<Attachment> = {}): VoiceAttachment {
  return {
    id: "a1",
    filename: "voice-message.webm",
    size: 1234,
    // Whatever the server sniffed: a webm clip arrives as video/webm.
    mime: "video/webm",
    url: "/api/v1/files/a1",
    duration_ms: 20_000,
    waveform: encodeWaveform(bytes),
    ...overrides,
  };
}

interface Harness {
  node: HTMLDivElement;
  audio: HTMLAudioElement & { currentTimeValue: number };
  fetchMedia: ReturnType<typeof vi.fn>;
}

const mounted: HTMLElement[] = [];

function setup(att = voiceAtt(), fetched: string | null = "blob:voice-1"): Harness {
  const audio = document.createElement("audio") as Harness["audio"];
  audio.currentTimeValue = 0;
  Object.defineProperty(audio, "duration", { get: () => 20, configurable: true });
  Object.defineProperty(audio, "currentTime", {
    get: () => audio.currentTimeValue,
    set: (v: number) => {
      audio.currentTimeValue = v;
    },
  });
  audio.play = vi.fn(async () => {
    audio.dispatchEvent(new Event("play"));
  });
  audio.pause = vi.fn(() => {
    audio.dispatchEvent(new Event("pause"));
  });
  const fetchMedia = vi.fn(async () => fetched);
  const node = renderVoicePlayer(att, "http://srv/api/v1/files/a1", {
    fetchMedia,
    downloadButton: () => document.createElement("button"),
    createAudio: () => audio,
  });
  document.body.appendChild(node);
  mounted.push(node);
  return { node, audio, fetchMedia };
}

afterEach(() => {
  for (const n of mounted.splice(0)) n.remove();
});

const q = <T extends Element>(node: Element, id: string): T =>
  node.querySelector<T>(`[data-testid="${id}"]`)!;

const key = (el: Element, k: string): void => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
};

describe("voice player", () => {
  it("recognises a voice attachment by its metadata, whatever the MIME", () => {
    expect(isVoiceAttachment(voiceAtt())).toBe(true);
    expect(isVoiceAttachment(voiceAtt({ mime: "audio/ogg" }))).toBe(true);
    const plain: Attachment = { id: "x", filename: "a.ogg", size: 1, mime: "audio/ogg", url: "/x" };
    expect(isVoiceAttachment(plain)).toBe(false);
    expect(isVoiceAttachment({ ...plain, duration_ms: 1000 })).toBe(false);
    expect(isVoiceAttachment({ ...plain, waveform: encodeWaveform(bytes) })).toBe(false);
    expect(isVoiceAttachment({ ...plain, duration_ms: 1000, waveform: "!!" })).toBe(false);
  });

  it("draws 64 bars from the waveform and fetches nothing until the first play", () => {
    const { node, fetchMedia, audio } = setup();
    expect(node.querySelectorAll(".msg-voice-bar")).toHaveLength(64);
    const heights = [...node.querySelectorAll<HTMLElement>(".msg-voice-bar")].map(
      (b) => b.style.height,
    );
    expect(new Set(heights).size).toBeGreaterThan(10);
    expect(fetchMedia).not.toHaveBeenCalled();
    expect(audio.getAttribute("src")).toBeNull();
    expect(q(node, "voice-time").textContent).toBe("0:20");
    expect(q(node, "voice-speed").textContent).toBe("1x");
  });

  it("fetches once on the first play, then pauses and resumes without refetching", async () => {
    const { node, fetchMedia, audio } = setup();
    const play = q<HTMLButtonElement>(node, "voice-play");
    play.click();
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));
    expect(fetchMedia).toHaveBeenCalledTimes(1);
    expect(fetchMedia).toHaveBeenCalledWith("http://srv/api/v1/files/a1");
    expect(audio.getAttribute("src")).toBe("blob:voice-1");
    expect(node.classList.contains("playing")).toBe(true);

    play.click();
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(node.classList.contains("playing")).toBe(false);
    play.click();
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(2));
    expect(fetchMedia).toHaveBeenCalledTimes(1);
  });

  it("ignores a second press while the file is loading", async () => {
    const gate: { resolve?: (u: string | null) => void } = {};
    const att = voiceAtt();
    const audio = document.createElement("audio");
    audio.play = vi.fn(async () => {});
    const fetchMedia = vi.fn(() => new Promise<string | null>((r) => (gate.resolve = r)));
    const node = renderVoicePlayer(att, "http://srv/f", {
      fetchMedia,
      downloadButton: () => document.createElement("button"),
      createAudio: () => audio,
    });
    document.body.appendChild(node);
    mounted.push(node);
    const play = q<HTMLButtonElement>(node, "voice-play");
    play.click();
    play.click();
    expect(fetchMedia).toHaveBeenCalledTimes(1);
    expect(play.disabled).toBe(true);
    gate.resolve?.("blob:x");
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalledTimes(1));
  });

  it("shows an error and lets the viewer try again when the fetch fails", async () => {
    const { node, fetchMedia } = setup(voiceAtt(), null);
    const play = q<HTMLButtonElement>(node, "voice-play");
    play.click();
    await vi.waitFor(() => expect(play.disabled).toBe(false));
    expect(node.querySelector<HTMLElement>(".msg-voice-error")?.hidden).toBe(false);
    play.click();
    expect(fetchMedia).toHaveBeenCalledTimes(2);
  });

  it("seeks 5 seconds per arrow key on the slider and exposes the value", () => {
    const { node } = setup();
    const slider = q<HTMLElement>(node, "voice-slider");
    expect(slider.getAttribute("role")).toBe("slider");
    expect(slider.getAttribute("aria-valuemin")).toBe("0");
    expect(slider.getAttribute("aria-valuemax")).toBe("20");
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
    key(slider, "ArrowRight");
    expect(slider.getAttribute("aria-valuenow")).toBe("5");
    expect(q(node, "voice-time").textContent).toBe("0:15");
    key(slider, "ArrowRight");
    key(slider, "ArrowUp");
    expect(slider.getAttribute("aria-valuenow")).toBe("15");
    key(slider, "ArrowLeft");
    expect(slider.getAttribute("aria-valuenow")).toBe("10");
    key(slider, "End");
    expect(slider.getAttribute("aria-valuenow")).toBe("20");
    key(slider, "ArrowRight");
    expect(slider.getAttribute("aria-valuenow")).toBe("20");
    key(slider, "Home");
    key(slider, "ArrowLeft");
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
  });

  it("fills the bars up to the position and seeks the audio once loaded", async () => {
    const { node, audio } = setup();
    const slider = q<HTMLElement>(node, "voice-slider");
    key(slider, "ArrowRight");
    key(slider, "ArrowRight"); // 10 s of 20 -> half the bars
    expect(node.querySelectorAll(".msg-voice-bar.played")).toHaveLength(32);
    q<HTMLButtonElement>(node, "voice-play").click();
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalled());
    expect(audio.currentTimeValue).toBe(10);
    // Playback advances the fill.
    audio.currentTimeValue = 15;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(node.querySelectorAll(".msg-voice-bar.played")).toHaveLength(48);
    expect(q(node, "voice-time").textContent).toBe("0:05");
    key(slider, "ArrowLeft");
    expect(audio.currentTimeValue).toBe(10);
  });

  it("seeks on a click on the waveform", () => {
    const { node } = setup();
    const slider = q<HTMLElement>(node, "voice-slider");
    slider.getBoundingClientRect = () => ({ left: 100, width: 200 }) as DOMRect;
    slider.dispatchEvent(new MouseEvent("pointerdown", { clientX: 200, bubbles: true, button: 0 }));
    expect(slider.getAttribute("aria-valuenow")).toBe("10");
    slider.dispatchEvent(new MouseEvent("pointermove", { clientX: 250, bubbles: true }));
    expect(slider.getAttribute("aria-valuenow")).toBe("15");
    slider.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    slider.dispatchEvent(new MouseEvent("pointermove", { clientX: 100, bubbles: true }));
    expect(slider.getAttribute("aria-valuenow")).toBe("15");
  });

  it("cycles the speed 1x -> 1.5x -> 2x -> 1x and applies it to the audio", () => {
    const { node, audio } = setup();
    const speed = q<HTMLButtonElement>(node, "voice-speed");
    speed.click();
    expect(speed.textContent).toBe("1.5x");
    expect(audio.playbackRate).toBe(1.5);
    speed.click();
    expect(speed.textContent).toBe("2x");
    expect(audio.playbackRate).toBe(2);
    speed.click();
    expect(speed.textContent).toBe("1x");
    expect(audio.playbackRate).toBe(1);
  });

  it("resets to the start when the clip ends", async () => {
    const { node, audio } = setup();
    q<HTMLButtonElement>(node, "voice-play").click();
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalled());
    audio.currentTimeValue = 20;
    audio.dispatchEvent(new Event("timeupdate"));
    audio.dispatchEvent(new Event("ended"));
    expect(q(node, "voice-slider").getAttribute("aria-valuenow")).toBe("0");
    expect(node.querySelectorAll(".msg-voice-bar.played")).toHaveLength(0);
  });

  it("keeps a download button", () => {
    const { node } = setup();
    expect(node.querySelectorAll("button").length).toBeGreaterThanOrEqual(3);
  });
});

/** An element like Chromium's for a MediaRecorder webm: Infinity until it has scanned to the end. */
function infiniteAudio() {
  const audio = document.createElement("audio");
  const state = { duration: Infinity, sets: [] as number[], time: 0 };
  Object.defineProperty(audio, "duration", { get: () => state.duration, configurable: true });
  Object.defineProperty(audio, "readyState", { get: () => 4, configurable: true });
  Object.defineProperty(audio, "currentTime", {
    get: () => state.time,
    set: (v: number) => {
      state.sets.push(v);
      state.time = v;
      if (v > 1e100) {
        state.duration = 20;
        queueMicrotask(() => audio.dispatchEvent(new Event("durationchange")));
      }
    },
  });
  audio.play = vi.fn(async () => {
    audio.dispatchEvent(new Event("play"));
  });
  audio.pause = vi.fn();
  return { audio, state };
}

function mount(audio: HTMLAudioElement): HTMLDivElement {
  const node = renderVoicePlayer(voiceAtt(), "http://srv/f", {
    fetchMedia: async () => "blob:x",
    downloadButton: () => document.createElement("button"),
    createAudio: () => audio,
  });
  document.body.appendChild(node);
  mounted.push(node);
  return node;
}

describe("voice player on a file with no duration header", () => {
  it("learns the length once, before the first seek, then lands on the chosen position", async () => {
    const { audio, state } = infiniteAudio();
    const node = mount(audio);
    const slider = q<HTMLElement>(node, "voice-slider");
    key(slider, "ArrowRight");
    key(slider, "ArrowRight"); // 10 s, before anything is loaded
    q<HTMLButtonElement>(node, "voice-play").click();
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalled());
    // Huge seek once, back to 0, then the wanted 10 s.
    expect(state.sets).toEqual([1e101, 0, 10]);
    expect(slider.getAttribute("aria-valuenow")).toBe("10");

    key(slider, "ArrowRight");
    expect(state.sets).toEqual([1e101, 0, 10, 15]);
  });

  it("does not run the workaround when the length is known", async () => {
    const { audio, state } = infiniteAudio();
    state.duration = 20;
    const node = mount(audio);
    key(q<HTMLElement>(node, "voice-slider"), "ArrowRight");
    q<HTMLButtonElement>(node, "voice-play").click();
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalled());
    expect(state.sets).toEqual([5]);
  });
});

function playable() {
  const audio = document.createElement("audio");
  Object.defineProperty(audio, "duration", { get: () => 20, configurable: true });
  audio.play = vi.fn(async () => {
    audio.dispatchEvent(new Event("play"));
  });
  audio.pause = vi.fn(() => {
    audio.dispatchEvent(new Event("pause"));
  });
  const node = renderVoicePlayer(voiceAtt(), "http://srv/f", {
    fetchMedia: async () => "blob:x",
    downloadButton: () => document.createElement("button"),
    createAudio: () => audio,
  });
  document.body.appendChild(node);
  mounted.push(node);
  return { audio, node };
}

describe("voice player lifetime", () => {
  it("pauses and releases a clip whose row was removed while it played", async () => {
    const { audio, node } = playable();
    q<HTMLButtonElement>(node, "voice-play").click();
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalled());
    node.remove();
    audio.dispatchEvent(new Event("timeupdate"));
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.getAttribute("src")).toBeNull();
    expect(node.classList.contains("playing")).toBe(false);
  });

  it("pauses a detached playing clip when another one starts", async () => {
    const a = playable();
    const b = playable();
    q<HTMLButtonElement>(a.node, "voice-play").click();
    await vi.waitFor(() => expect(a.audio.play).toHaveBeenCalled());
    a.node.remove(); // detached, still playing: the DOM cannot find it
    q<HTMLButtonElement>(b.node, "voice-play").click();
    await vi.waitFor(() => expect(b.audio.play).toHaveBeenCalled());
    expect(a.audio.pause).toHaveBeenCalledTimes(1);
    expect(b.audio.pause).not.toHaveBeenCalled();
  });

  it("pauses every playing clip when the session ends", async () => {
    const a = playable();
    q<HTMLButtonElement>(a.node, "voice-play").click();
    await vi.waitFor(() => expect(a.audio.play).toHaveBeenCalled());
    runSessionResets("user");
    expect(a.audio.pause).toHaveBeenCalledTimes(1);
  });
});
