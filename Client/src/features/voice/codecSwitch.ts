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
 * H.264 can fall back to OpenH264 after the encoder starts. Check both
 * cameras and shares after publication and after capture changes, with one
 * retry if the encoder name is unavailable. An observed OpenH264 fallback
 * keeps that track on VP8 until it ends. Each check owns its timer and identity,
 * so a result from before a change or disconnect cannot alter a newer capture.
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
import { createLogger } from "@lib/logger";
import { voiceStore } from "../../stores/voice.store";
import { pickCommonCodec } from "./decodeCaps";
import { isLinuxDesktop } from "./native/platform";
import { channelPeerDecode } from "./peerDecode";
import type { ShareSenderSample } from "./shareSenderStats";
import type { PublishCodec } from "./videoCodec";

const log = createLogger("codecSwitch");

/** A switch down waits this long after the pick changes. */
export const SWITCH_DOWN_MS = 1500;
/** A switch up waits until the pick has held this long... */
export const SWITCH_UP_STABLE_MS = 10_000;
/** ...and at least this long after the last switch of the same kind. */
export const SWITCH_UP_MIN_GAP_MS = 30_000;
/** How long to wait before looking again at a share that is changing source. */
export const SWITCH_BUSY_RETRY_MS = 2000;

/** How long a live H.264 video runs before its encoder is read. */
export const SOFTWARE_CHECK_MS = 4000;

type Kind = "camera" | "screen";

interface EncoderCheck {
  track?: object;
  timer: ReturnType<typeof setTimeout> | null;
  fallback?: object;
}

function newEncoderCheck(): EncoderCheck {
  return { timer: null };
}

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
  readonly readCameraSenderSample: () => Promise<ShareSenderSample | null>;
  /** A switch threw outside republishVideo's own handling. */
  readonly onSwitchError: (err: unknown) => void;
}

export class CodecSwitchController {
  private unsubscribe: (() => void) | null = null;
  private slots: Record<Kind, Slot> = { camera: newSlot(), screen: newSlot() };
  /** Bumped by `stop`: a flight that started before it leaves the new slots alone. */
  private epoch = 0;
  private changes = { camera: 0, screen: 0 };
  private checks: Record<Kind, EncoderCheck> = {
    camera: newEncoderCheck(),
    screen: newEncoderCheck(),
  };

  constructor(private readonly host: CodecSwitchHost) {}

  /** Start watching the pick (once) and look at both kinds now. Called when an
   *  enable finishes, since a track still being enabled is not switched. */
  kick(): void {
    this.unsubscribe ??= voiceStore.subscribeSelector(
      () => this.pickKey(),
      () => this.evaluateAll(),
    );
    this.evaluateAll();
    this.scheduleSoftwareCheck("camera");
    this.scheduleSoftwareCheck("screen");
  }

  /** The session ended or is reconnecting: drop the subscription and every
   *  timer. A switch in flight is cut short by the generation bump that comes
   *  with the same teardown. */
  stop(): void {
    this.epoch++;
    this.changes = { camera: 0, screen: 0 };
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearSoftwareCheck("camera");
    this.clearSoftwareCheck("screen");
    this.checks = { camera: newEncoderCheck(), screen: newEncoderCheck() };
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
    if (this.checks[kind].fallback !== undefined && this.checks[kind].fallback === this.track(kind))
      return "vp8";
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

  private track(kind: Kind): object | undefined {
    return kind === "camera"
      ? this.host.getCameraState().announced
      : this.host.getScreenState().announced;
  }

  /** Invalidate pending stats before changing capture, including in-place changes
   * that keep the LocalVideoTrack wrapper. Never restart after session teardown. */
  async checkAfterChange(kind: Kind, change: () => Promise<void>): Promise<void> {
    const epoch = this.epoch;
    this.clearSoftwareCheck(kind);
    const changes = this.changes;
    changes[kind]++;
    try {
      await change();
    } finally {
      changes[kind]--;
      if (epoch === this.epoch && changes[kind] === 0) this.kick();
    }
  }

  private clearSoftwareCheck(kind: Kind): void {
    const check = this.checks[kind];
    if (check.timer !== null) clearTimeout(check.timer);
    this.checks[kind] = { ...check, timer: null, track: undefined };
  }

  private scheduleSoftwareCheck(kind: Kind): void {
    const live = this.live(kind);
    const track = this.track(kind);
    const check = this.checks[kind];
    if (live === null || live.published !== "h264" || isLinuxDesktop()) {
      if (check.track !== undefined) this.clearSoftwareCheck(kind);
      return;
    }
    if (this.changes[kind] > 0 || track === check.track) return;
    this.clearSoftwareCheck(kind);
    this.checks[kind].track = track;
    this.armSoftwareCheck(kind, true);
  }

  private armSoftwareCheck(kind: Kind, retry: boolean): void {
    const check = this.checks[kind];
    const timer = setTimeout(() => {
      if (check.timer === timer) check.timer = null;
      if (check !== this.checks[kind]) return;
      this.checkSoftwareEncoder(kind, check, retry).catch((err: unknown) =>
        this.host.onSwitchError(err),
      );
    }, SOFTWARE_CHECK_MS);
    check.timer = timer;
  }

  private async checkSoftwareEncoder(
    kind: Kind,
    check: EncoderCheck,
    retry: boolean,
  ): Promise<void> {
    const track = check.track;
    const sample = await (kind === "camera"
      ? this.host.readCameraSenderSample()
      : this.host.readScreenSenderSample());
    if (
      check !== this.checks[kind] ||
      this.track(kind) !== track ||
      this.live(kind)?.published !== "h264"
    )
      return;
    if (sample?.encoder === undefined) {
      if (retry) this.armSoftwareCheck(kind, false);
      return;
    }
    const software = /openh264/i.test(sample.encoder);
    // Only media diagnostics, never source names or device identifiers.
    log.info(software ? "H.264 software fallback to VP8" : "H.264 encoder checked", {
      kind,
      encoder: sample.encoder,
      width: sample.width,
      height: sample.height,
      captureFps: sample.captureFps,
      sentFps: sample.sentFps,
      limitation: sample.limitation,
    });
    if (!software) return;
    check.fallback = track;
    await this.run(kind, this.slots[kind]);
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
