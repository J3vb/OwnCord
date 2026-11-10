/**
 * Keeps a live camera and screen share under the server's video upload cap
 * while it changes, with no republish.
 *
 * One follower per voice session. It watches the cap (`onVideoBitrateCap`) and
 * whether the camera and the share are live (a start or a stop changes the
 * split), works out each live stream's budget and sets it on the running
 * sender: `RTCRtpSender.setParameters` on the web path, a host command on the
 * Linux native path. Both hold the top layer to the stream's capped rate and
 * every lower layer under it.
 *
 * A share that is changing source or quality is left alone and looked at again
 * shortly: its own publish already read the cap, and the re-apply that follows
 * puts it on the newest one. A re-apply never outlives its stream: after each
 * await the track and its generation are checked, so a stop or a replaced
 * track is never touched.
 */

import { RoomEvent, type LocalVideoTrack, type Room } from "livekit-client";
import { createLogger } from "../../lib/logger";
import { voiceStore } from "../../stores/voice.store";
import { setSenderTop, recordSenderLayers } from "../../lib/voice/senderLayers";
import {
  type StreamQuality,
  CAMERA_PUBLISH_BITRATES,
  budgetedRate,
  getScreenShareFps,
  getScreenShareMaxBitrate,
} from "../../lib/voice/videoPresets";
import { onVideoBitrateCap } from "./videoBitrateCap";
import { liveVideoBudget } from "./videoBudgetNow";
import type { ShareSenderSample } from "./shareSenderStats";
import type { CameraTrackState, ScreenTrackState } from "./videoTrackState";

const log = createLogger("videoCapFollow");

/** How long to wait before looking again at a share that is changing. */
export const CAP_FOLLOW_BUSY_RETRY_MS = 500;

type Kind = "camera" | "screen";

/** The Linux native room: it changes a published video's bitrate through the
 *  host, in place. The web `Room` has no such method, so the follower picks by
 *  what the room can do, not by platform. */
export interface NativeBitrateRoom {
  /** Hold the room's published camera or share `track` under `maxBitrate` bits
   *  per second; a track that is no longer the live publication is dropped. */
  setVideoBitrate(kind: Kind, track: object, maxBitrate: number): Promise<void>;
}

function isNativeBitrateRoom(room: Room | null): room is Room & NativeBitrateRoom {
  return typeof (room as Partial<NativeBitrateRoom> | null)?.setVideoBitrate === "function";
}

export interface VideoCapHost {
  readonly getRoom: () => Room | null;
  readonly getCameraState: () => CameraTrackState;
  readonly getScreenState: () => ScreenTrackState;
}

/** A live stream as the follower sees it. */
interface LiveVideo {
  readonly track: object;
  readonly generation: number;
  readonly busy: boolean;
  /** The rate the stream's quality asks for, before any cap. */
  readonly preset: number;
}

interface Slot {
  running: boolean;
  dirty: boolean;
  retry: ReturnType<typeof setTimeout> | null;
}

function newSlot(): Slot {
  return { running: false, dirty: false, retry: null };
}

function cameraVideo(state: CameraTrackState): LiveVideo | null {
  const track = state.announced;
  if (track === undefined || state.manualCameraTrack !== track) return null;
  if (state.quality === undefined) return null;
  return {
    track,
    generation: state.generation ?? 0,
    busy: false,
    preset: presetRate("camera", state.quality),
  };
}

function screenVideo(state: ScreenTrackState): LiveVideo | null {
  const track = state.announced;
  if (track === undefined || !state.manualScreenTracks.includes(track)) return null;
  if (state.quality === undefined) return null;
  return {
    track,
    generation: state.generation ?? 0,
    busy: state.changing === true,
    preset: presetRate("screen", state.quality, state.fps ?? getScreenShareFps()),
  };
}

/** The rate a quality asks for, before any cap. */
export function presetRate(kind: Kind, quality: StreamQuality, fps = 30): number {
  return kind === "camera"
    ? CAMERA_PUBLISH_BITRATES[quality]
    : getScreenShareMaxBitrate(quality, fps);
}

/** The top rate a stream goes out at: its preset under its budget. */
function topRate(kind: Kind, preset: number): number {
  const budget = liveVideoBudget();
  return budgetedRate(preset, kind === "camera" ? budget.camera : budget.screen);
}

/** Write `top` into the options the SDK saved at publish, so a recompute from
 *  them (a source swap, a full reconnect's republish) agrees with the cap. */
function keepInOptions(kind: Kind, track: LocalVideoTrack, top: number): void {
  const options = track.publishOptions;
  if (options === undefined) return;
  track.publishOptions =
    kind === "camera"
      ? { ...options, videoEncoding: { ...options.videoEncoding, maxBitrate: top } }
      : { ...options, screenShareEncoding: { ...options.screenShareEncoding, maxBitrate: top } };
}

/** Set `top` on a live web track: its saved options and its sender. */
async function setWebTop(kind: Kind, track: LocalVideoTrack, top: number): Promise<void> {
  keepInOptions(kind, track, top);
  await setSenderTop(track.sender, top);
}

/** Set `top` on a live track: the host for a native room, else its sender. */
async function applyTop(room: Room | null, kind: Kind, track: object, top: number): Promise<void> {
  if (isNativeBitrateRoom(room)) {
    await room.setVideoBitrate(kind, track, top);
    return;
  }
  await setWebTop(kind, track as LocalVideoTrack, top);
}

/** What the server lets a live share send when that is below what its quality
 *  asks for, in bits per second; 0 when the share is not held back. */
export function shareServerLimit(state: ScreenTrackState): number {
  if (state.quality === undefined) return 0;
  const budget = liveVideoBudget().screen;
  const preset = presetRate("screen", state.quality, state.fps ?? getScreenShareFps());
  return budget > 0 && budget < preset ? budget : 0;
}

/** `sample` with the server's limit on the share added when it holds the share
 *  back. Not a sender stat, so the diagnostics keep the sample as read. */
export function withServerLimit(
  sample: ShareSenderSample | null,
  state: ScreenTrackState,
): ShareSenderSample | null {
  const serverLimit = shareServerLimit(state);
  return serverLimit > 0 ? { ...sample, serverLimit } : sample;
}

/** Hold a just-published web track's lower layers under its top (the publish
 *  options already capped the top). Records the layers the SDK produced, so a
 *  later change can restore them. Never throws: a failed clamp must not undo a
 *  publish that worked. */
export async function clampPublishedVideo(
  track: object | undefined,
  kind: Kind,
  preset: number,
): Promise<void> {
  // A native track has no sender: the host clamps its own publish.
  const sender = (track as LocalVideoTrack | undefined)?.sender;
  if (sender === undefined) return;
  try {
    recordSenderLayers(sender);
    // Always: a cap lifted while this publish was in flight left nothing for
    // the follower to set (the sender did not exist yet).
    await setWebTop(kind, track as LocalVideoTrack, topRate(kind, preset));
  } catch (err) {
    log.warn("Could not hold the published layers under the cap", err);
  }
}

export class VideoCapFollower {
  private unsubscribes: Array<() => void> = [];
  /** The room whose reconnects are watched, and how to stop watching. */
  private watched: { room: Room; off: () => void } | null = null;
  private slots: Record<Kind, Slot> = { camera: newSlot(), screen: newSlot() };
  /** Bumped by `stop`: a run that began before it leaves everything alone. */
  private epoch = 0;

  constructor(private readonly host: VideoCapHost) {}

  /** Start following (once) and bring both live streams under the cap now.
   *  Called when a camera or share enable finishes. */
  kick(): void {
    if (this.unsubscribes.length === 0) {
      this.unsubscribes.push(
        onVideoBitrateCap(() => this.reapplyAll()),
        voiceStore.subscribeSelector(
          // The revs move when a source swap or device switch rebuilt the layers.
          (s) =>
            `${s.localCamera}|${s.localScreenshare}|${s.localCameraRev ?? 0}|${s.localShareRev ?? 0}`,
          () => this.reapplyAll(),
        ),
      );
    }
    this.watchReconnects();
    this.reapplyAll();
  }

  /** A reconnect republishes tracks from the options saved at publish (the
   *  Linux host does the same), which undoes a live cap: apply it again. */
  private watchReconnects(): void {
    const room = this.host.getRoom();
    if (room === null || this.watched?.room === room) return;
    this.watched?.off();
    const onReconnected = (): void => this.reapplyAll();
    room.on(RoomEvent.Reconnected, onReconnected);
    this.watched = { room, off: () => room.off(RoomEvent.Reconnected, onReconnected) };
  }

  /** The session ended or is reconnecting: drop the subscriptions and timers. */
  stop(): void {
    this.epoch++;
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    this.watched?.off();
    this.watched = null;
    for (const slot of Object.values(this.slots)) {
      if (slot.retry !== null) clearTimeout(slot.retry);
    }
    this.slots = { camera: newSlot(), screen: newSlot() };
  }

  private live(kind: Kind): LiveVideo | null {
    return kind === "camera"
      ? cameraVideo(this.host.getCameraState())
      : screenVideo(this.host.getScreenState());
  }

  private reapplyAll(): void {
    this.reapply("camera");
    this.reapply("screen");
  }

  private reapply(kind: Kind): void {
    this.run(kind).catch((err: unknown) => log.warn("Could not follow the video cap", err));
  }

  /** One run per kind at a time; a request that arrives meanwhile runs again
   *  when this one ends, so the last cap wins. */
  private async run(kind: Kind): Promise<void> {
    const slot = this.slots[kind];
    if (slot.running) {
      slot.dirty = true;
      return;
    }
    slot.running = true;
    const epoch = this.epoch;
    try {
      do {
        slot.dirty = false;
        // oxlint-disable-next-line no-await-in-loop -- a re-run starts after the last one ends
        await this.applyOnce(kind, slot, epoch);
      } while (slot.dirty && epoch === this.epoch);
    } finally {
      slot.running = false;
    }
  }

  private async applyOnce(kind: Kind, slot: Slot, epoch: number): Promise<void> {
    const live = this.live(kind);
    if (live === null) return;
    if (live.busy) {
      this.retryLater(kind, slot, epoch);
      return;
    }
    await applyTop(this.host.getRoom(), kind, live.track, topRate(kind, live.preset)).catch(
      (err: unknown) => {
        // A stop that lands mid-call closes the sender: nothing to follow then.
        if (epoch === this.epoch && this.stillLive(kind, live)) {
          log.warn("Could not set the video cap on a live stream", err);
        }
      },
    );
    // The stream went or was replaced while the call ran: nothing more to do.
    // A cap that changed meanwhile already marked the slot dirty.
  }

  private stillLive(kind: Kind, live: LiveVideo): boolean {
    const now = this.live(kind);
    return now !== null && now.track === live.track && now.generation === live.generation;
  }

  private retryLater(kind: Kind, slot: Slot, epoch: number): void {
    if (slot.retry !== null) return;
    slot.retry = setTimeout(() => {
      slot.retry = null;
      if (epoch === this.epoch) this.reapply(kind);
    }, CAP_FOLLOW_BUSY_RETRY_MS);
  }
}
