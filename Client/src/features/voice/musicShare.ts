/**
 * Music share: publish one app's sound as a second audio track beside the
 * microphone (source `ScreenShareAudio`, name "music"), independent of a
 * screen share. The Linux native room publishes in the host (`nativeMusicOf`);
 * everywhere else the host serves the sound on a loopback socket that the page
 * opens with `openAppAudio` and publishes, as the screen-share app audio does
 * (`lib/voice/appAudioShare.ts`, the pattern: a stale check after every await,
 * a start counter so only the latest start stops the host, and everything
 * closed on failure).
 *
 * `epoch` moves on every start and every stop, so a start whose host call was
 * still pending when a stop, leave or newer start landed sees itself stale and
 * releases what it made. `starts` moves only on a start: a stale start stops
 * the host capture only while no newer start owns it.
 */

import { LocalAudioTrack } from "livekit-client";
import { setLocalMusic } from "@stores/voice.store";
import { createLogger } from "@lib/logger";
import { showToast } from "@lib/ui/toast";
import { openAppAudio } from "@lib/voice/appAudioTrack";
import { MUSIC_PUBLISH } from "@lib/voice/musicPublish";
import { nativeMusicOf, type NativeMusicRoom, type VoiceRoom } from "@lib/voice/voiceRoom";
import { desktop } from "../../platform/desktop";
import type { MusicErrorCode } from "../../platform/contracts/musicAudio";
import { voiceText } from "../../i18n/voice";

const log = createLogger("musicShare");

export type MusicStartOutcome = "started" | "failed" | "stale";

export interface MusicShareHost {
  getRoom(): VoiceRoom | null;
}

export interface MusicStartOptions {
  /** Raise no toast for a refusal: the caller words it (a restore). */
  readonly quiet?: boolean;
}

interface ActiveMusic {
  readonly appId: string;
  /** Release the page side, the published track and the host capture. */
  close(): void;
}

const CODES: readonly MusicErrorCode[] = [
  "unavailable",
  "not_found",
  "activation_failed",
  "superseded",
  "internal",
];

/** The host's refusal code in a rejection (a string, or a `NativeCallError`
 *  carrying it as `reason`). */
export function musicErrorCode(err: unknown): MusicErrorCode {
  const reason = typeof err === "object" && err !== null && "reason" in err ? err.reason : err;
  return typeof reason === "string" && (CODES as readonly string[]).includes(reason)
    ? (reason as MusicErrorCode)
    : "internal";
}

/** The toast for a refusal, or null when the refusal is the expected answer. */
function refusalText(code: MusicErrorCode): string | null {
  if (code === "superseded") return null;
  return voiceText(code === "not_found" ? "music.notFound" : "music.failed");
}

export class MusicShare {
  private active: ActiveMusic | null = null;
  private epoch = 0;
  private starts = 0;
  /** Starts waiting on the host; a stop acts on the host only for these. */
  private starting = 0;

  constructor(private readonly host: MusicShareHost) {}

  /** The app being shared, or null. */
  get appId(): string | null {
    return this.active?.appId ?? null;
  }

  /** Share app `appId`, replacing a running share. "stale" means a stop, a
   *  leave or a newer start took over meanwhile: nothing is left running for
   *  this call and nothing is announced. */
  async start(appId: string, options: MusicStartOptions = {}): Promise<MusicStartOutcome> {
    const room = this.host.getRoom();
    if (room === null) return "failed";
    this.release();
    const myStart = ++this.starts;
    const mine = ++this.epoch;
    const ctx: StartContext = {
      room,
      appId,
      quiet: options.quiet === true,
      stale: () => this.epoch !== mine || this.host.getRoom() !== room,
      // A newer start replaced the host capture itself; only the latest stops it.
      stopHost: () => {
        if (this.starts === myStart) this.stopHostCapture(room);
      },
      ended: () => this.endedBy(mine),
    };
    const native = nativeMusicOf(room);
    this.starting++;
    let active: ActiveMusic | "failed" | "stale";
    try {
      active = native !== null ? await this.startNative(ctx, native) : await this.startPage(ctx);
    } finally {
      this.starting--;
    }
    if (active === "failed") return ctx.stale() ? "stale" : "failed";
    if (active === "stale") return "stale";
    this.active = active;
    setLocalMusic(true);
    return "started";
  }

  /** Stop sharing (the user's Stop, a leave, a reconnect): releases what runs
   *  and supersedes a start still waiting on the host. */
  stop(): void {
    this.epoch++;
    const hadActive = this.release();
    // A start still awaiting the host owns a capture nothing here holds yet.
    if (!hadActive && this.starting > 0) this.stopHostCapture(this.host.getRoom());
  }

  private release(): boolean {
    const active = this.active;
    this.active = null;
    if (active === null) return false;
    setLocalMusic(false);
    try {
      active.close();
    } catch (err) {
      log.warn("Closing the music share failed", err);
    }
    return true;
  }

  private stopHostCapture(room: VoiceRoom | null): void {
    const native = nativeMusicOf(room);
    const done = native !== null ? native.stopMusic() : desktop.musicAudio.stop();
    done.catch((err: unknown) => log.debug("Stopping the music capture failed", err));
  }

  /** The stream ended on its own (the app's capture closed, the host
   *  withdrew the track): stop with a notice, if this share is still current. */
  private endedBy(epoch: number): void {
    if (this.epoch !== epoch) return;
    this.stop();
    showToast(voiceText("music.ended"), "warning");
  }

  private async startNative(
    ctx: StartContext,
    native: NativeMusicRoom,
  ): Promise<ActiveMusic | "failed" | "stale"> {
    const unsubscribe = native.onMusicEnded(ctx.ended);
    try {
      await native.startMusic(ctx.appId);
    } catch (err) {
      unsubscribe();
      return this.refused(ctx, musicErrorCode(err));
    }
    if (ctx.stale()) {
      unsubscribe();
      ctx.stopHost();
      return "stale";
    }
    return {
      appId: ctx.appId,
      close: () => {
        unsubscribe();
        this.stopHostCapture(ctx.room);
      },
    };
  }

  private async startPage(ctx: StartContext): Promise<ActiveMusic | "failed" | "stale"> {
    const started = await desktop.musicAudio.start(ctx.appId);
    if (!started.ok) return this.refused(ctx, started.code);
    if (ctx.stale()) {
      ctx.stopHost();
      return "stale";
    }
    let handle: Awaited<ReturnType<typeof openAppAudio>>;
    try {
      handle = await openAppAudio(started.url, ctx.ended);
    } catch (err) {
      log.warn("Music socket could not be opened", err);
      return this.refused(ctx, "internal");
    }
    if (ctx.stale()) {
      handle.close();
      ctx.stopHost();
      return "stale";
    }
    const track = new LocalAudioTrack(handle.track, undefined, true);
    try {
      await ctx.room.localParticipant.publishTrack(track, MUSIC_PUBLISH);
    } catch (err) {
      log.warn("Publishing the music failed", err);
      handle.close();
      return this.refused(ctx, "internal");
    }
    const unpublish = (): void => {
      ctx.room.localParticipant.unpublishTrack(track, true).catch((err: unknown) => {
        log.warn("Failed to unpublish the music (non-fatal)", err);
      });
    };
    if (ctx.stale()) {
      handle.close();
      unpublish();
      ctx.stopHost();
      return "stale";
    }
    return {
      appId: ctx.appId,
      close: () => {
        handle.close();
        unpublish();
        this.stopHostCapture(ctx.room);
      },
    };
  }

  /** A host refusal: release the capture, tell the user unless it is the
   *  expected answer or the caller words it. */
  private refused(ctx: StartContext, code: MusicErrorCode): "failed" | "stale" {
    ctx.stopHost();
    if (ctx.stale()) return "stale";
    log.warn("Music share did not start", { code });
    const text = refusalText(code);
    if (!ctx.quiet && text !== null) showToast(text, "warning");
    return "failed";
  }
}

interface StartContext {
  readonly room: VoiceRoom;
  readonly appId: string;
  readonly quiet: boolean;
  stale(): boolean;
  stopHost(): void;
  ended(): void;
}
