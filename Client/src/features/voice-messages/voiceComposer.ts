/**
 * The composer's voice-message recorder bar. It swaps the input row for
 * a recording bar (red dot, timer, live bars, Discard, Send), uploads the clip
 * when sent and posts it as a message of its own.
 *
 * The recording and the clip belong to the composer that started them: its
 * destroy (a channel switch, a reconnect that rebuilds the composer) stops the
 * microphone and drops the clip, and nothing is uploaded or sent afterwards.
 * An upload that fails keeps the clip with Retry and Discard; Send and Retry are
 * one button that is disabled while an upload runs, so a clip is never sent twice.
 */

import { isImeCommit } from "@lib/text/ime";
import { Disposable } from "@lib/disposable";
import { createElement } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { VoiceUploadMeta } from "@lib/types";
import { authStore } from "@stores/auth.store";
import { ATTACHMENT_TTL_MS } from "../messaging/attachmentTtl";
import { voiceMessagesText } from "../../i18n/voiceMessages";
import {
  createVoiceRecorder,
  type VoiceClip,
  type VoiceRecorder,
  type VoiceRecorderOptions,
  VoiceRecordError,
} from "./recorder";
import { bucketMax, formatClock } from "./waveform";

/** Bars drawn in the recording bar. */
const BAR_COUNT = 48;

export interface VoiceUploadResult {
  readonly id: string;
  readonly url: string;
  readonly filename: string;
}

export interface VoiceComposerOptions {
  /** Where the bar goes (inside the composer root, beside the input row). */
  readonly host: HTMLElement;
  /** The node the bar goes before (the input row), or the end of `host`. */
  readonly before?: Node | null;
  /** Gets `voice-active` while the bar shows; the input row hides under it. */
  readonly root: HTMLElement;
  /** The composer's lifetime: aborting it is a destroy. */
  readonly signal: AbortSignal;
  readonly upload: (
    file: File,
    voice: VoiceUploadMeta,
    signal: AbortSignal,
  ) => Promise<VoiceUploadResult>;
  /** Withdraw an upload that finished after its clip was discarded. */
  readonly discardUpload?: (id: string) => Promise<void>;
  /** Post the message: one attachment, no text. */
  readonly send: (attachment: { id: string; filename: string; file: File }) => void;
  /** Why the composer cannot send right now, or null. */
  readonly gate: () => string | null;
  /** A line in the composer for a failure that has no bar to show it in. */
  readonly onError: (message: string) => void;
  readonly onClearError: () => void;
  /** The bar opened (true) or closed (false). */
  readonly onActiveChange?: (active: boolean) => void;
  /** Tests build the recorder from fakes. */
  readonly createRecorder?: (
    hooks: Pick<VoiceRecorderOptions, "onLevel" | "onLimit" | "onDeviceLost">,
  ) => VoiceRecorder;
}

export interface VoiceComposer {
  /** Start recording (the mic button). */
  start(): void;
  /** Whether the bar is showing. */
  isActive(): boolean;
  /** Discard whatever is recorded or pending. */
  cancel(): void;
  /** Stop the microphone and drop everything; nothing is sent after this. */
  destroy(): void;
}

type Phase = "idle" | "starting" | "recording" | "stopping" | "ready" | "uploading" | "failed";

interface Bar {
  readonly el: HTMLDivElement;
  readonly time: HTMLSpanElement;
  readonly ticks: readonly HTMLSpanElement[];
  readonly status: HTMLDivElement;
  readonly cancel: HTMLButtonElement;
  readonly primary: HTMLButtonElement;
}

function buildBar(): Bar {
  const el = createElement("div", {
    class: "voice-bar",
    role: "group",
    "aria-label": voiceMessagesText("bar.label"),
    "data-testid": "voice-bar",
  });
  const row = createElement("div", { class: "voice-bar-row" });
  const cancel = createElement("button", {
    class: "voice-bar-btn voice-bar-cancel",
    type: "button",
    title: voiceMessagesText("bar.discard"),
    "aria-label": voiceMessagesText("bar.discard"),
    "data-testid": "voice-cancel",
  });
  cancel.appendChild(createIcon("trash-2", 18));
  const dot = createElement("span", { class: "voice-bar-dot", "aria-hidden": "true" });
  const time = createElement("span", { class: "voice-bar-time" }, formatClock(0));
  const wave = createElement("div", { class: "voice-bar-wave", "aria-hidden": "true" });
  const ticks: HTMLSpanElement[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    const tick = createElement("span", { class: "voice-bar-tick" });
    ticks.push(tick);
    wave.appendChild(tick);
  }
  const primary = createElement("button", {
    class: "voice-bar-btn voice-bar-send",
    type: "button",
    "data-testid": "voice-send",
  });
  const status = createElement("div", {
    class: "voice-bar-status",
    role: "status",
    "data-testid": "voice-error",
  });
  status.hidden = true;
  row.append(cancel, dot, time, wave, primary);
  el.append(row, status);
  return { el, time, ticks, status, cancel, primary };
}

function paintTicks(ticks: readonly HTMLSpanElement[], levels: readonly number[]): void {
  // Level 0..1 to a bar height; a quiet tick keeps a visible stub.
  for (let i = 0; i < ticks.length; i++) {
    const level = levels[i] ?? 0;
    ticks[i]?.style.setProperty("height", `${Math.round(10 + Math.min(1, level) * 90)}%`);
  }
}

export function createVoiceComposer(options: VoiceComposerOptions): VoiceComposer {
  let phase: Phase = "idle";
  let alive = true;
  let bar: Bar | null = null;
  let recorder: VoiceRecorder | null = null;
  let clip: VoiceClip | null = null;
  let file: File | null = null;
  let uploaded: VoiceUploadResult | null = null;
  let uploadedAt = 0;
  let session: Disposable | null = null;
  let uploadOwner: Disposable | null = null;
  let recent: number[] = [];
  /** The clip can never be sent to this server (too large): Retry is pointless. */
  let blocked = false;

  function setStatus(text: string | null, kind: "error" | "info" = "error"): void {
    if (bar === null) return;
    bar.status.hidden = text === null;
    bar.status.textContent = text ?? "";
    bar.status.classList.toggle("voice-bar-error", kind === "error");
    bar.status.setAttribute("role", kind === "error" ? "alert" : "status");
  }

  /** Reflect the phase onto the bar's buttons and labels. */
  function render(): void {
    if (bar === null) return;
    const busy = phase === "stopping" || phase === "uploading";
    bar.el.dataset["phase"] = phase;
    bar.el.classList.toggle("recording", phase === "recording");
    bar.primary.disabled = busy || blocked;
    bar.primary.setAttribute("aria-busy", String(busy));
    bar.primary.replaceChildren();
    if (phase === "failed") {
      bar.primary.classList.add("voice-bar-retry");
      bar.primary.textContent = voiceMessagesText("bar.retry");
      bar.primary.removeAttribute("title");
      bar.primary.removeAttribute("aria-label");
    } else {
      bar.primary.classList.remove("voice-bar-retry");
      const label = voiceMessagesText("bar.send");
      bar.primary.title = label;
      bar.primary.setAttribute("aria-label", label);
      bar.primary.appendChild(createIcon("send", 18));
    }
    if (phase === "uploading") setStatus(voiceMessagesText("bar.uploading"), "info");
  }

  function showClipBars(): void {
    if (bar === null || clip === null) return;
    const levels = bucketMax(clip.bars, BAR_COUNT).map((v) => v / 255);
    paintTicks(bar.ticks, levels);
    bar.time.textContent = formatClock(Math.round(clip.durationMs / 1000));
  }

  function closeBar(): void {
    session?.destroy();
    session = null;
    bar?.el.remove();
    bar = null;
    options.root.classList.remove("voice-active");
  }

  /** Withdraw an upload nothing will use, freeing its quota now. Best effort. */
  function withdraw(id: string): void {
    try {
      void options.discardUpload?.(id)?.catch(() => {});
    } catch {
      // A withdrawal that cannot start leaves the server's sweep to clean up.
    }
  }

  /** Drop the recording, the clip and the bar; the composer is back to typing. */
  function reset(notify: boolean): void {
    const wasOpen = bar !== null;
    uploadOwner?.destroy();
    uploadOwner = null;
    recorder?.dispose();
    recorder = null;
    clip = null;
    file = null;
    // A retained upload that was not sent is withdrawn (a send clears it first).
    if (uploaded !== null) withdraw(uploaded.id);
    uploaded = null;
    recent = [];
    phase = "idle";
    blocked = false;
    closeBar();
    if (wasOpen && notify) options.onActiveChange?.(false);
  }

  function openBar(): void {
    const built = buildBar();
    bar = built;
    session = new Disposable();
    options.host.insertBefore(built.el, options.before ?? null);
    options.root.classList.add("voice-active");
    built.cancel.addEventListener("click", () => cancel(), { signal: session.signal });
    built.primary.addEventListener("click", () => void submit(), { signal: session.signal });
    // Escape cancels, ahead of the app-wide Escape (mark the channel read).
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key !== "Escape" || isImeCommit(e) || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        cancel();
      },
      { capture: true, signal: session.signal },
    );
    paintTicks(built.ticks, []);
    render();
    options.onActiveChange?.(true);
    built.primary.focus();
  }

  function onLevel(peak: number, elapsedMs: number): void {
    if (bar === null || phase !== "recording") return;
    recent.push(peak);
    if (recent.length > BAR_COUNT) recent = recent.slice(recent.length - BAR_COUNT);
    // Newest on the right; the bars fill from the left as the clip grows.
    paintTicks(bar.ticks, recent);
    bar.time.textContent = formatClock(Math.floor(elapsedMs / 1000));
  }

  function onLimit(result: VoiceClip | null): void {
    if (!alive || phase !== "recording") return;
    if (result === null) {
      reset(true);
      options.onError(voiceMessagesText("error.tooShort"));
      return;
    }
    holdClip(result);
    setStatus(voiceMessagesText("bar.limit"), "info");
  }

  function onDeviceLost(): void {
    if (!alive || bar === null || phase !== "recording") return;
    reset(true);
    options.onError(voiceMessagesText("error.deviceLost"));
  }

  function holdClip(result: VoiceClip): void {
    clip = result;
    file = new File([result.blob], result.filename, { type: result.mime });
    uploaded = null;
    phase = "ready";
    render();
    showClipBars();
  }

  function start(): void {
    if (!alive || phase !== "idle") return;
    const refusal = options.gate();
    if (refusal !== null) {
      options.onError(refusal);
      return;
    }
    options.onClearError();
    phase = "starting";
    const rec = (options.createRecorder ?? createVoiceRecorder)({ onLevel, onLimit, onDeviceLost });
    recorder = rec;
    void rec.start().then(
      () => {
        // Destroyed or discarded while the permission prompt was up.
        if (!alive || recorder !== rec || phase !== "starting") {
          rec.dispose();
          return;
        }
        phase = "recording";
        openBar();
      },
      (err: unknown) => {
        if (recorder !== rec) return;
        recorder = null;
        phase = "idle";
        const kind = err instanceof VoiceRecordError ? err.kind : "failed";
        if (kind === "cancelled" || !alive) return;
        options.onError(
          kind === "denied"
            ? voiceMessagesText("error.denied")
            : kind === "no-device"
              ? voiceMessagesText("error.noDevice")
              : kind === "unsupported"
                ? voiceMessagesText("error.unsupported")
                : kind === "suspended"
                  ? voiceMessagesText("error.suspended")
                  : voiceMessagesText("error.failed"),
        );
      },
    );
  }

  async function submit(): Promise<void> {
    if (!alive || bar === null) return;
    if (phase === "recording") {
      const rec = recorder;
      if (rec === null) return;
      phase = "stopping";
      render();
      let result: VoiceClip | null;
      try {
        result = await rec.stop();
      } catch {
        if (!alive || recorder !== rec) return;
        reset(true);
        options.onError(voiceMessagesText("error.recordingFailed"));
        return;
      }
      if (!alive || recorder !== rec || phase !== "stopping") return;
      if (result === null) {
        reset(true);
        options.onError(voiceMessagesText("error.tooShort"));
        return;
      }
      holdClip(result);
    }
    if ((phase !== "ready" && phase !== "failed") || clip === null || file === null) return;
    await upload(clip, file);
  }

  async function upload(held: VoiceClip, heldFile: File): Promise<void> {
    const refusal = options.gate();
    if (refusal !== null) {
      phase = "failed";
      render();
      setStatus(refusal);
      return;
    }
    // The server sweeps an unsent upload after about an hour: a retained id
    // that old is withdrawn and the held clip uploads again.
    if (uploaded !== null && Date.now() - uploadedAt >= ATTACHMENT_TTL_MS) {
      withdraw(uploaded.id);
      uploaded = null;
    }
    const max = authStore.getState().uploadPolicy?.max_upload_bytes;
    if (uploaded === null && max !== undefined && max > 0 && heldFile.size > max) {
      blocked = true;
      phase = "failed";
      render();
      setStatus(voiceMessagesText("error.tooLarge"));
      return;
    }
    phase = "uploading";
    render();
    if (uploaded === null) {
      const owner = new Disposable();
      uploadOwner = owner;
      try {
        const result = await options.upload(
          heldFile,
          { durationMs: held.durationMs, waveform: held.waveform },
          owner.signal,
        );
        if (uploadOwner !== owner || !alive || clip !== held) {
          // Discarded while it ran: nothing will use this upload.
          withdraw(result.id);
          return;
        }
        uploaded = result;
        uploadedAt = Date.now();
      } catch {
        if (uploadOwner !== owner || !alive || clip !== held || owner.signal.aborted) return;
        phase = "failed";
        render();
        setStatus(voiceMessagesText("error.uploadFailed"));
        return;
      } finally {
        if (uploadOwner === owner) uploadOwner = null;
      }
    }
    const final = options.gate();
    if (final !== null) {
      // The composer was gated while the upload ran: keep the uploaded clip.
      phase = "failed";
      render();
      setStatus(final);
      return;
    }
    const posted = uploaded;
    if (posted === null) return;
    uploaded = null; // handed to the message: reset() must not withdraw it
    reset(true);
    options.send({ id: posted.id, filename: posted.filename, file: heldFile });
  }

  function cancel(): void {
    if (phase === "idle" || !alive) return;
    reset(true);
  }

  function destroy(): void {
    if (!alive) return;
    alive = false;
    reset(false);
  }

  options.signal.addEventListener("abort", destroy, { once: true });
  if (options.signal.aborted) destroy();

  return { start, isActive: () => phase !== "idle", cancel, destroy };
}
