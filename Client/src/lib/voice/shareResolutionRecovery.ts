/**
 * Getting a screen share's resolution back after a bandwidth dip.
 *
 * Under bandwidth pressure WebRTC asks for smaller frames, and Chromium's
 * capturer shrinks the share's source to match. When the bandwidth comes back
 * WebRTC asks for larger frames again, but the capturer never grows the
 * source: the encoder keeps waiting for a frame size that never arrives, and
 * the share stays small for the rest of the session at full frame rate.
 * Re-asserting the degradation preference clears WebRTC's restrictions; the
 * source returns to full size at once and adaptation starts again from there.
 *
 * The nudge fires only for a share that is stuck: a sending layer smaller than
 * its capture allows, held back for bandwidth, unchanged for `STUCK_MS`, while
 * the encoder's target bitrate has risen `RECOVERED_RATIO` times above the
 * lowest it reached at that size. `COOLDOWN_MS` bounds how often a link that
 * keeps falling again pays for the brief full-size restart.
 */

import { createLogger } from "@lib/logger";

const log = createLogger("shareResolutionRecovery");

const POLL_MS = 2000;
export const STUCK_MS = 10_000;
export const COOLDOWN_MS = 30_000;
export const RECOVERED_RATIO = 2;

/** One read of the share's widest sending layer. */
export interface RecoveryReading {
  readonly now: number;
  /** The width this layer would have at the capture's full size. */
  readonly fullWidth: number;
  readonly width: number;
  readonly targetBitrate: number;
  readonly limitation?: string;
}

export interface RecoveryState {
  /** The layer width being watched, and since when it has held. */
  readonly width?: number;
  readonly since: number;
  /** The lowest target bitrate seen at that width. */
  readonly minTarget: number;
  readonly lastNudge?: number;
}

export const initialRecoveryState: RecoveryState = { since: 0, minTarget: Infinity };

/** Fold one reading in; `nudge` says the share is stuck and should restart. */
export function recoveryStep(
  state: RecoveryState,
  r: RecoveryReading,
): { state: RecoveryState; nudge: boolean } {
  if (state.width !== r.width) {
    return {
      state: { ...state, width: r.width, since: r.now, minTarget: r.targetBitrate },
      nudge: false,
    };
  }
  const minTarget = Math.min(state.minTarget, r.targetBitrate);
  const nudge =
    r.width < r.fullWidth * 0.9 &&
    r.limitation === "bandwidth" &&
    r.now - state.since >= STUCK_MS &&
    r.targetBitrate >= minTarget * RECOVERED_RATIO &&
    (state.lastNudge === undefined || r.now - state.lastNudge >= COOLDOWN_MS);
  if (!nudge) return { state: { ...state, minTarget }, nudge: false };
  // Start the next stretch afresh: the restart changes the size anyway.
  return { state: { since: r.now, minTarget: Infinity, lastNudge: r.now }, nudge: true };
}

interface OutboundRow {
  readonly type?: string;
  readonly kind?: string;
  readonly rid?: string;
  readonly frameWidth?: number;
  readonly targetBitrate?: number;
  readonly qualityLimitationReason?: string;
  readonly active?: boolean;
}

/** The widest active layer's reading, or null while there is none to judge. */
export function readingFromStats(
  rows: Iterable<OutboundRow>,
  encodings: readonly RTCRtpEncodingParameters[],
  captureWidth: number,
  now: number,
): RecoveryReading | null {
  let best: RecoveryReading | null = null;
  let bestAt = -1;
  for (const row of rows) {
    if (row.type !== "outbound-rtp" || row.kind !== "video" || row.active === false) continue;
    const { frameWidth, targetBitrate } = row;
    // A layer the allocator gave nothing says nothing about recovery.
    if (frameWidth === undefined || targetBitrate === undefined || targetBitrate <= 0) continue;
    const encoding = encodings.find((e) => e.rid === row.rid) ?? encodings[0];
    const fullWidth = captureWidth / (encoding?.scaleResolutionDownBy ?? 1);
    // Layers of the same size (a 720p capture's two layers): the one listed
    // last is the share's top layer, whatever the report order and whatever a
    // cap did to their rates (the rule `topIndex` uses for the sender).
    const at = encoding === undefined ? 0 : encodings.indexOf(encoding);
    const smaller =
      best !== null &&
      (best.fullWidth > fullWidth || (best.fullWidth === fullWidth && bestAt >= at));
    if (smaller) continue;
    bestAt = at;
    best = {
      now,
      fullWidth,
      width: frameWidth,
      targetBitrate,
      limitation: row.qualityLimitationReason,
    };
  }
  return best;
}

/** The number a size constraint asks for, whichever form it takes. */
function constrained(c: ConstrainULong | undefined): number | undefined {
  return typeof c === "number" ? c : (c?.exact ?? c?.max ?? c?.ideal);
}

/** The width the capture runs at when nothing holds it back: the shared
 *  surface fitted into the size the share asked for. The surface comes from
 *  the capabilities, which keep the real size while the settings shrink with
 *  the source; without them, the settings are the best there is. */
export function fullCaptureWidth(track: MediaStreamTrack): number {
  const caps = typeof track.getCapabilities === "function" ? track.getCapabilities() : {};
  const settings = track.getSettings();
  const width = caps.width?.max ?? settings.width ?? 0;
  const height = caps.height?.max ?? settings.height ?? 0;
  const wanted = typeof track.getConstraints === "function" ? track.getConstraints() : {};
  const maxWidth = constrained(wanted.width);
  const maxHeight = constrained(wanted.height);
  const scale = Math.min(
    1,
    maxWidth !== undefined && width > 0 ? maxWidth / width : 1,
    maxHeight !== undefined && height > 0 ? maxHeight / height : 1,
  );
  return width * scale;
}

/** What the watcher needs of the published share video (a LocalVideoTrack). */
export interface RecoveryTrack {
  readonly sender?: RTCRtpSender;
  readonly mediaStreamTrack: MediaStreamTrack;
  setDegradationPreference(preference: RTCDegradationPreference): Promise<void>;
}

/** Watch a published share and restart its resolution when it is stuck.
 *  `preference` is the one the share was published with; it is restored
 *  straight after the nudge. Returns the stop function. */
export function watchShareResolutionRecovery(
  track: RecoveryTrack,
  preference: RTCDegradationPreference,
): () => void {
  let state = initialRecoveryState;
  let source: MediaStreamTrack | undefined;
  let busy = false;
  let stopped = false;
  const tick = async (): Promise<void> => {
    const sender = track.sender;
    if (busy || sender === undefined) return;
    busy = true;
    try {
      // A new source (Change source) has its own size: start over.
      if (track.mediaStreamTrack !== source) {
        source = track.mediaStreamTrack;
        state = initialRecoveryState;
      }
      const captureWidth = fullCaptureWidth(source);
      const report = await sender.getStats();
      if (stopped || captureWidth === 0) return;
      const reading = readingFromStats(
        report.values() as Iterable<OutboundRow>,
        sender.getParameters().encodings,
        captureWidth,
        Date.now(),
      );
      if (reading === null) return;
      const step = recoveryStep(state, reading);
      state = step.state;
      if (!step.nudge) return;
      log.info("Share resolution stuck below its capture; restarting adaptation", {
        width: reading.width,
        fullWidth: Math.round(reading.fullWidth),
        targetBitrate: reading.targetBitrate,
      });
      const other = preference === "maintain-resolution" ? "balanced" : "maintain-resolution";
      await track.setDegradationPreference(other);
      await track.setDegradationPreference(preference);
    } catch (err) {
      log.debug("Share resolution check skipped", err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
