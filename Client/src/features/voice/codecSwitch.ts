/**
 * The live codec switch: keeps a published camera or screen share on
 * a codec every viewer decodes.
 *
 * Voice E2EE leaves no backup codec and the SFU does not transcode, so when a
 * viewer who cannot decode the codec a live track went out with joins, the
 * track must be published again with one they can. One controller per voice
 * session watches the common-codec pick (`pickCommonCodec` over the peers'
 * decode lists, which the roster and the announces change) and, when the pick
 * is no longer what a live track was published with, republishes that track
 * (`republishVideo`). It only reads stores; server events still reach them
 * through the dispatcher.
 *
 * Timing, per kind: a switch down to VP8 waits 1.5 s, which coalesces a join
 * with its announce; a switch back up waits until the pick has held for 10 s
 * and at most 30 s after the last switch. A peer flapping every 2 s therefore
 * causes one switch down and none up. One switch runs at a time per kind; a
 * change that arrives meanwhile re-runs the pick when it ends. The controller
 * does nothing for a track that is still being enabled (the enable's end
 * calls `kick`) and waits out a Change source or Quality change.
 *
 * One more switch is not about viewers: MediaCapabilities can say hardware for
 * H.264 while WebRTC falls back to OpenH264 when the encoder starts (a
 * 3440x1440 frame the GPU refuses). OpenH264 is single-threaded, so the
 * share either drops to a few fps or shrinks to a blur to keep up. So a few seconds after an H.264 screen share goes live off Linux,
 * a sender sample names the encoder (once more if it has no name yet); an
 * OpenH264 one, even on only a lower simulcast layer, republishes the share as
 * VP8 and that share stays VP8 until it ends.
 */

import {
  cameraLiveCodec,
  republishVideo,
  screenLiveCodec,
  type CameraTrackState,
  type LiveCodec,
  type ScreenTrackState,
  type VideoTrackDeps,
} from "../../lib/voice/screenShare";
import { voiceStore } from "../../stores/voice.store";
import { pickCommonCodec } from "./decodeCaps";
import { isLinuxDesktop } from "./native/platform";
import { channelPeerDecode } from "./peerDecode";
import type { ShareSenderSample } from "./shareSenderStats";
import type { PublishCodec } from "./videoCodec";

/** A switch down waits this long after the pick changes. */
export const SWITCH_DOWN_MS = 1500;
/** A switch up waits until the pick has held this long... */
export const SWITCH_UP_STABLE_MS = 10_000;
/** ...and at least this long after the last switch of the same kind. */
export const SWITCH_UP_MIN_GAP_MS = 30_000;
/** How long to wait before looking again at a share that is changing source. */
export const SWITCH_BUSY_RETRY_MS = 2000;

/** How long a live H.264 screen share runs before its encoder is read. */
export const SOFTWARE_CHECK_MS = 4000;

type Kind = "camera" | "screen";

interface Pending {
  readonly target: PublishCodec;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** One kind's switch state. */
interface Slot {
  inFlight: boolean;
  pending: Pending | null;
  lastSwitchAt: number;
}

function newSlot(): Slot {
  return { inFlight: false, pending: null, lastSwitchAt: -Infinity };
}

export interface CodecSwitchHost {
  readonly getCameraState: () => CameraTrackState;
  readonly getScreenState: () => ScreenTrackState;
  readonly getDeps: () => VideoTrackDeps;
  /** One sender stats sample of the live screen share, null where it has none. */
  readonly readScreenSenderSample: () => Promise<ShareSenderSample | null>;
  /** A switch threw outside republishVideo's own handling. */
  readonly onSwitchError: (err: unknown) => void;
}

export class CodecSwitchController {
  private unsubscribe: (() => void) | null = null;
  private slots: Record<Kind, Slot> = { camera: newSlot(), screen: newSlot() };
  /** Bumped by `stop`: a flight that started before it leaves the new slots alone. */
  private epoch = 0;
  /** The share track the software-encoder check was scheduled for: one check
   *  per publish, however often `kick` runs. */
  private softwareTrack: object | undefined;
  private softwareTimer: ReturnType<typeof setTimeout> | null = null;
  /** The share track whose H.264 encoder turned out to be OpenH264: that share
   *  stays VP8, and a later share never inherits it. */
  private softwareH264Track: object | undefined;

  constructor(private readonly host: CodecSwitchHost) {}

  /** Start watching the pick (once) and look at both kinds now. Called when an
   *  enable finishes, since a track still being enabled is not switched. */
  kick(): void {
    this.unsubscribe ??= voiceStore.subscribeSelector(
      () => this.pickKey(),
      () => this.evaluateAll(),
    );
    this.evaluateAll();
    this.scheduleSoftwareCheck();
  }

  /** The session ended or is reconnecting: drop the subscription and every
   *  timer. A switch in flight is cut short by the generation bump that comes
   *  with the same teardown. */
  stop(): void {
    this.epoch++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearSoftwareCheck();
    this.softwareH264Track = undefined;
    for (const slot of Object.values(this.slots)) this.clearPending(slot);
    this.slots = { camera: newSlot(), screen: newSlot() };
  }

  private live(kind: Kind): LiveCodec | null {
    return kind === "camera"
      ? cameraLiveCodec(this.host.getCameraState())
      : screenLiveCodec(this.host.getScreenState());
  }

  /** Only a VP9 or H.265 publish switches live: down to VP8, which every
   *  shipped client plays, when a peer cannot decode it, and back up when
   *  every peer can. Every shipped client plays VP8 and H.264, so a peer list
   *  without them never moves an H.264 or VP8 publish. */
  private pick(kind: Kind, live: LiveCodec): PublishCodec {
    if (kind === "screen" && this.isSoftwareH264Share()) return "vp8";
    if (live.preferred !== "vp9" && live.preferred !== "h265") return live.published;
    return pickCommonCodec(live.preferred, channelPeerDecode());
  }

  /** The selector: changes exactly when a live kind's pick changes. */
  private pickKey(): string {
    return (["camera", "screen"] as const)
      .map((kind) => {
        const live = this.live(kind);
        return live === null ? "-" : this.pick(kind, live);
      })
      .join("|");
  }

  private isSoftwareH264Share(): boolean {
    const track = this.softwareH264Track;
    return track !== undefined && track === this.host.getScreenState().announced;
  }

  private clearSoftwareCheck(): void {
    if (this.softwareTimer !== null) clearTimeout(this.softwareTimer);
    this.softwareTimer = null;
    this.softwareTrack = undefined;
  }

  /** Schedule the software-encoder check for a live H.264 screen share (not
   *  on Linux, whose native engine names its own encoder). */
  private scheduleSoftwareCheck(): void {
    const live = this.live("screen");
    const track = this.host.getScreenState().announced;
    if (live === null) {
      this.clearSoftwareCheck();
      return;
    }
    if (live.published !== "h264" || isLinuxDesktop() || track === this.softwareTrack) return;
    this.clearSoftwareCheck();
    this.softwareTrack = track;
    this.armSoftwareCheck(track, true);
  }

  private armSoftwareCheck(track: object | undefined, retry: boolean): void {
    const epoch = this.epoch;
    const timer = setTimeout(() => {
      if (this.softwareTimer === timer) this.softwareTimer = null;
      if (epoch !== this.epoch) return;
      this.checkSoftwareEncoder(epoch, track, retry).catch((err: unknown) =>
        this.host.onSwitchError(err),
      );
    }, SOFTWARE_CHECK_MS);
    this.softwareTimer = timer;
  }

  private async checkSoftwareEncoder(
    epoch: number,
    track: object | undefined,
    retry: boolean,
  ): Promise<void> {
    const sample = await this.host.readScreenSenderSample();
    if (epoch !== this.epoch || this.host.getScreenState().announced !== track) return;
    if (sample?.encoder === undefined) {
      // The sender may not have named its encoder yet: look once more.
      if (retry && this.softwareTrack === track) this.armSoftwareCheck(track, false);
      return;
    }
    if (!/openh264/i.test(sample.encoder)) return;
    this.softwareH264Track = track;
    await this.run("screen", this.slots.screen);
  }

  private evaluateAll(): void {
    this.evaluate("camera");
    this.evaluate("screen");
  }

  private clearPending(slot: Slot): void {
    if (slot.pending !== null) clearTimeout(slot.pending.timer);
    slot.pending = null;
  }

  private evaluate(kind: Kind): void {
    const slot = this.slots[kind];
    const live = this.live(kind);
    if (live === null) {
      this.clearPending(slot);
      return;
    }
    // A change during a flight is not lost: the flight ends with a new look.
    if (slot.inFlight) return;
    const target = this.pick(kind, live);
    if (target === live.published) {
      this.clearPending(slot);
      return;
    }
    // Already waiting for this very target: the wait keeps its start.
    if (slot.pending?.target === target) return;
    this.clearPending(slot);
    let delay: number;
    if (live.busy) delay = SWITCH_BUSY_RETRY_MS;
    else if (target === "vp8") delay = SWITCH_DOWN_MS;
    else {
      delay = Math.max(SWITCH_UP_STABLE_MS, slot.lastSwitchAt + SWITCH_UP_MIN_GAP_MS - Date.now());
    }
    const epoch = this.epoch;
    slot.pending = {
      target,
      timer: setTimeout(() => {
        slot.pending = null;
        if (epoch === this.epoch) {
          this.run(kind, slot).catch((err: unknown) => this.host.onSwitchError(err));
        }
      }, delay),
    };
  }

  private async run(kind: Kind, slot: Slot): Promise<void> {
    const live = this.live(kind);
    if (live === null) return;
    if (slot.inFlight) return;
    const target = this.pick(kind, live);
    if (target === live.published) return;
    if (live.busy) {
      this.evaluate(kind);
      return;
    }
    const epoch = this.epoch;
    slot.inFlight = true;
    slot.lastSwitchAt = Date.now();
    try {
      // republishVideo logs its own failures and takes the disable path.
      if (kind === "camera") {
        await republishVideo("camera", this.host.getCameraState(), this.host.getDeps(), target);
      } else {
        await republishVideo("screen", this.host.getScreenState(), this.host.getDeps(), target);
      }
    } finally {
      slot.inFlight = false;
    }
    if (epoch !== this.epoch) return;
    this.evaluate(kind);
  }
}
