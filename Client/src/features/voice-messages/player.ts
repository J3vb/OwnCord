/**
 * The voice-message player: an attachment that carries a waveform and a
 * length renders as this, whatever MIME the server sniffed for its bytes.
 *
 * The bars come from the attachment's own metadata, so nothing is downloaded
 * until the first play. The length shown is the attachment's `duration_ms`, not
 * the audio element's: a MediaRecorder file has no duration header, so its
 * element reports Infinity.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setOwnedTimeout } from "@lib/dom";
import { registerSessionReset } from "@lib/sessionRegistry";
import { createIcon } from "@lib/icons";
import type { Attachment } from "@lib/types";
import { voiceMessagesText } from "../../i18n/voiceMessages";
import { bucketMax, decodeWaveform, formatClock, WAVEFORM_BARS } from "./waveform";

/** A key press on the waveform seeks this far. */
export const SEEK_STEP_SECONDS = 5;
/** 1x, then 1.5x, then 2x, then round again. */
export const PLAYBACK_SPEEDS: readonly number[] = [1, 1.5, 2];

export type VoiceAttachment = Attachment & {
  readonly duration_ms: number;
  readonly waveform: string;
};

/** Whether `att` is a voice message: both the length and a decodable waveform. */
export function isVoiceAttachment(att: Attachment): att is VoiceAttachment {
  return (
    typeof att.duration_ms === "number" &&
    att.duration_ms > 0 &&
    typeof att.waveform === "string" &&
    decodeWaveform(att.waveform) !== null
  );
}

/**
 * Every audio element that is playing, so starting one pauses the rest even when
 * a row was removed from the document (a detached element keeps playing and
 * `querySelectorAll` cannot see it). A session end pauses them all.
 */
const playingAudios = new Set<HTMLAudioElement>();
// app-lifetime: the playing set is module state that outlives every player
void registerSessionReset(
  "voice-messages:player",
  () => {
    for (const audio of playingAudios) audio.pause();
    playingAudios.clear();
  },
  { phase: "cache" },
);

/** The longest the duration workaround waits for the element. */
const DURATION_WAIT_MS = 3000;
/** Past any real length: seeking here makes Chromium scan to the end of the file. */
const HUGE_SEEK_SECONDS = 1e101;

/** Resolve on the first of `events` on `target`, or after `ms`. */
function waitForEvent(target: EventTarget, events: readonly string[], ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const scope = new Disposable();
    const finish = (): void => {
      scope.destroy();
      resolve();
    };
    for (const name of events) target.addEventListener(name, finish, { signal: scope.signal });
    setOwnedTimeout(scope.signal, finish, ms);
  });
}

/**
 * A MediaRecorder file has no duration header, so its element reports Infinity
 * and Chromium cannot seek it. The known workaround: seek far past the end, wait
 * for the element to learn the real length, then go back to the start.
 */
async function learnDuration(audio: HTMLAudioElement): Promise<void> {
  if (Number.isFinite(audio.duration)) return;
  if (audio.readyState < 1)
    await waitForEvent(audio, ["loadedmetadata", "error"], DURATION_WAIT_MS);
  if (Number.isFinite(audio.duration)) return;
  audio.currentTime = HUGE_SEEK_SECONDS;
  await waitForEvent(audio, ["durationchange", "timeupdate", "error"], DURATION_WAIT_MS);
  audio.currentTime = 0;
}

export interface VoicePlayerDeps {
  /** The authenticated fetch of the file as a blob: URL, or null on failure. */
  readonly fetchMedia: (url: string) => Promise<string | null>;
  /** The attachment's download button, kept beside the player. */
  readonly downloadButton: () => HTMLElement;
  /** Tests pass a fake element. */
  readonly createAudio?: () => HTMLAudioElement;
}

export function renderVoicePlayer(
  att: VoiceAttachment,
  resolvedUrl: string,
  deps: VoicePlayerDeps,
): HTMLDivElement {
  const totalSeconds = att.duration_ms / 1000;
  const levels = bucketMax(decodeWaveform(att.waveform) ?? [], WAVEFORM_BARS).map((v) => v / 255);

  const wrap = createElement("div", {
    class: "msg-file msg-voice",
    role: "group",
    "aria-label": voiceMessagesText("player.group", {
      duration: formatClock(Math.round(totalSeconds)),
    }),
    "data-testid": "voice-player",
  });
  const audio = deps.createAudio?.() ?? createElement("audio", { preload: "none" });
  audio.classList.add("msg-voice-audio");
  audio.hidden = true;

  const playBtn = createElement("button", {
    class: "msg-voice-play",
    type: "button",
    "data-testid": "voice-play",
    "aria-label": voiceMessagesText("player.play"),
  });
  playBtn.appendChild(createIcon("play", 18));

  const slider = createElement("div", {
    class: "msg-voice-wave",
    role: "slider",
    tabindex: "0",
    "aria-label": voiceMessagesText("player.seek"),
    "aria-valuemin": "0",
    "aria-valuemax": String(Math.round(totalSeconds)),
    "data-testid": "voice-slider",
  });
  const bars = levels.map((level) => {
    const bar = createElement("span", { class: "msg-voice-bar", "aria-hidden": "true" });
    bar.style.setProperty("height", `${Math.round(12 + level * 88)}%`);
    slider.appendChild(bar);
    return bar;
  });

  const timeEl = createElement("span", { class: "msg-voice-time", "data-testid": "voice-time" });
  const speedBtn = createElement("button", {
    class: "msg-voice-speed",
    type: "button",
    "data-testid": "voice-speed",
  });
  const failure = createElement("div", { class: "msg-voice-error", role: "status" });
  failure.hidden = true;

  let speedIndex = 0;
  let position = 0; // seconds
  let loading = false;
  let loaded = false;
  let playing = false;

  const clampPosition = (seconds: number): number => Math.max(0, Math.min(totalSeconds, seconds));

  function paintSpeed(): void {
    const speed = String(PLAYBACK_SPEEDS[speedIndex] ?? 1);
    speedBtn.textContent = voiceMessagesText("player.speedValue", { speed });
    speedBtn.setAttribute(
      "aria-label",
      voiceMessagesText("player.speed", {
        speed: voiceMessagesText("player.speedValue", { speed }),
      }),
    );
  }

  function paintPosition(): void {
    const fraction = totalSeconds === 0 ? 0 : position / totalSeconds;
    const filled = Math.round(fraction * bars.length);
    bars.forEach((bar, i) => bar.classList.toggle("played", i < filled));
    slider.style.setProperty("--voice-progress", String(fraction));
    slider.setAttribute("aria-valuenow", String(Math.round(position)));
    slider.setAttribute(
      "aria-valuetext",
      voiceMessagesText("player.seekValue", {
        elapsed: formatClock(Math.floor(position)),
        total: formatClock(Math.round(totalSeconds)),
      }),
    );
    // The time left, counting up to the whole length before the first play.
    timeEl.textContent = formatClock(Math.ceil(totalSeconds - position));
  }

  function paintPlaying(): void {
    playBtn.replaceChildren(createIcon(playing ? "pause" : "play", 18));
    playBtn.setAttribute(
      "aria-label",
      voiceMessagesText(loading ? "player.loading" : playing ? "player.pause" : "player.play"),
    );
    playBtn.setAttribute("aria-busy", String(loading));
    playBtn.disabled = loading;
    wrap.classList.toggle("playing", playing);
  }

  let durationFixed = false;
  let fixing: Promise<void> | null = null;

  /** Move the audio to `position`; the first move on an unknown-length file learns the length first. */
  function applyAudioPosition(): void {
    if (fixing !== null) return; // it lands on the latest position when done
    if (durationFixed || Number.isFinite(audio.duration)) {
      audio.currentTime = position;
      return;
    }
    durationFixed = true;
    fixing = learnDuration(audio).then(() => {
      fixing = null;
      audio.currentTime = position;
    });
  }

  function seek(seconds: number): void {
    position = clampPosition(seconds);
    if (loaded) applyAudioPosition();
    paintPosition();
  }

  async function ensureLoaded(): Promise<boolean> {
    if (loaded) return true;
    if (loading) return false;
    loading = true;
    failure.hidden = true;
    paintPlaying();
    const objectUrl = await deps.fetchMedia(resolvedUrl);
    loading = false;
    if (objectUrl === null) {
      failure.textContent = voiceMessagesText("player.loadFailed");
      failure.hidden = false;
      paintPlaying();
      return false;
    }
    audio.src = objectUrl;
    audio.defaultPlaybackRate = PLAYBACK_SPEEDS[speedIndex] ?? 1;
    audio.playbackRate = PLAYBACK_SPEEDS[speedIndex] ?? 1;
    loaded = true;
    if (position > 0) {
      applyAudioPosition();
      await fixing;
    }
    return true;
  }

  async function togglePlay(): Promise<void> {
    if (playing) {
      audio.pause();
      return;
    }
    if (!(await ensureLoaded())) return;
    // The row was recycled while the file loaded: it would play unseen.
    if (!wrap.isConnected) return;
    if (position >= totalSeconds) seek(0);
    try {
      await audio.play();
    } catch {
      // Playback refused (an autoplay policy): the button stays, press it again.
      playing = false;
      paintPlaying();
    }
  }

  playBtn.addEventListener("click", () => void togglePlay());

  audio.addEventListener("play", () => {
    playing = true;
    // One voice message at a time.
    for (const other of playingAudios) if (other !== audio) other.pause();
    playingAudios.add(audio);
    paintPlaying();
  });
  audio.addEventListener("pause", () => {
    playing = false;
    playingAudios.delete(audio);
    paintPlaying();
  });
  audio.addEventListener("timeupdate", () => {
    // The row was removed (channel switch, re-render, recycle): stop and let go.
    if (playing && !wrap.isConnected) {
      audio.pause();
      audio.removeAttribute("src");
      loaded = false;
      return;
    }
    if (!loaded || fixing !== null) return;
    position = clampPosition(audio.currentTime);
    paintPosition();
  });
  audio.addEventListener("ended", () => {
    if (fixing !== null) return;
    playing = false;
    playingAudios.delete(audio);
    position = 0;
    if (loaded) audio.currentTime = 0;
    paintPosition();
    paintPlaying();
  });
  audio.addEventListener("error", () => {
    playing = false;
    playingAudios.delete(audio);
    loaded = false;
    failure.textContent = voiceMessagesText("player.loadFailed");
    failure.hidden = false;
    paintPlaying();
  });

  speedBtn.addEventListener("click", () => {
    speedIndex = (speedIndex + 1) % PLAYBACK_SPEEDS.length;
    const rate = PLAYBACK_SPEEDS[speedIndex] ?? 1;
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    paintSpeed();
  });

  slider.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    let next: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = position + SEEK_STEP_SECONDS;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = position - SEEK_STEP_SECONDS;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = totalSeconds;
        break;
      default:
        return;
    }
    e.preventDefault();
    seek(next);
  });

  // Click or drag on the bars seeks; nothing downloads until Play.
  let dragging = false;
  const seekFromPointer = (e: PointerEvent): void => {
    const rect = slider.getBoundingClientRect();
    if (rect.width <= 0) return;
    seek(((e.clientX - rect.left) / rect.width) * totalSeconds);
  };
  slider.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging = true;
    try {
      slider.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic pointer has nothing to capture.
    }
    seekFromPointer(e);
  });
  slider.addEventListener("pointermove", (e: PointerEvent) => {
    if (dragging) seekFromPointer(e);
  });
  const endDrag = (): void => {
    dragging = false;
  };
  slider.addEventListener("pointerup", endDrag);
  slider.addEventListener("pointercancel", endDrag);

  const body = createElement("div", { class: "msg-voice-body" });
  const meta = createElement("div", { class: "msg-voice-meta" });
  meta.append(timeEl, speedBtn);
  body.append(slider, meta, failure);
  const inner = createElement("div", { class: "msg-file-inner" });
  inner.append(playBtn, body, deps.downloadButton(), audio);
  wrap.appendChild(inner);

  paintSpeed();
  paintPosition();
  paintPlaying();
  return wrap;
}
