// Automatic input sensitivity: a noise-floor estimate over the detector's
// level reports, a voice-level estimate over the reports the gate let
// through, and the gate threshold placed between the two.
//
// The floor is the quietest level seen in the last WINDOW_MS (minimum
// statistics over 1 s sub-windows). A quieter level lowers it at once; a
// louder room lifts it once the quiet sub-windows age out. Speech cannot
// carry it: every pause between words reaches the room's own level, and one
// pause in the window is enough. Steady music or a fan does become the floor,
// which is the point: the user talks over it.
//
// The threshold starts a margin above the floor. Once the user has spoken,
// it moves halfway up toward a margin below their voice, so a breath, a
// chair or a keyboard that clears the floor does not open the gate when the
// voice is far above them, and a quiet voice over a loud room keeps the
// floor margin.

/** Margin of the gate threshold above the noise floor. */
export const AUTO_MARGIN_DB = 10;
/** Margin the gate threshold keeps below the voice, so soft consonants and
 *  word tails still pass. */
export const SPEECH_MARGIN_DB = 15;
/** Lowest automatic threshold (-55 dBFS): suppressed near-silence must not
 *  park the gate where breathing opens it. */
export const AUTO_MIN_THRESHOLD = 10 ** (-55 / 20);
/** Highest automatic threshold (-26 dBFS): a loud room never pushes the gate
 *  above ordinary speech. */
export const AUTO_MAX_THRESHOLD = 0.05;

const SUBWINDOW_MS = 1000;
/** A rising floor (a fan, automatic gain creeping up) is followed within this. */
const WINDOW_MS = 3000;
/** Levels needed before the first estimate replaces the seed. */
const WARMUP_MS = 1000;
/** Reports ignored after an input-volume change, while its gain ramp settles. */
const SETTLE_MS = 200;
/** A smaller move than this is not worth re-sending to the gate. */
const MOVE_DB = 1;
/** A report this far above the current threshold is the voice, not the
 *  room: it feeds the voice-level estimate. */
const SPEECH_ABOVE_DB = 6;
/** Weight of one report in the voice-level average: about a second of
 *  speech at 20 reports a second. */
const SPEECH_ALPHA = 0.05;

/** Below this a report is digital silence (a muted or stopped capture, the
 *  input volume at 0), not the room: it must not become the floor, or the
 *  room's own noise would open the gate after an unmute. */
const SILENCE_RMS = 1e-5;

const toDb = (rms: number): number => 20 * Math.log10(Math.max(rms, 1e-5));
const fromDb = (db: number): number => 10 ** (db / 20);

export class NoiseFloorTracker {
  /** Closed sub-windows still inside the window: start time and quietest level. */
  private readonly closed: Array<{ start: number; minDb: number }> = [];
  private windowStart: number | null = null;
  private windowMinDb = Infinity;
  private firstAt: number | null = null;
  private skipUntil = -Infinity;
  private speechDb: number | null = null;
  private current: number;

  /** `seed`: the threshold to gate at until the first estimate (a restarted
   *  detector passes its predecessor's, so it does not reopen the mic). */
  constructor(seed?: number) {
    this.current = Math.min(
      AUTO_MAX_THRESHOLD,
      Math.max(AUTO_MIN_THRESHOLD, seed ?? AUTO_MAX_THRESHOLD),
    );
  }

  /** The threshold the gate should run at now. */
  get threshold(): number {
    return this.current;
  }

  /** The voice level learned so far (RMS), null until the user has spoken
   *  above the gate. */
  get speechLevel(): number | null {
    return this.speechDb === null ? null : fromDb(this.speechDb);
  }

  /** Forget the learned floor and voice after the input volume moved: the
   *  levels behind the old gain (and its ramp) say nothing about the new
   *  one. The threshold holds until the new levels have been heard for the
   *  warm-up. */
  reset(nowMs: number): void {
    this.closed.length = 0;
    this.windowStart = null;
    this.windowMinDb = Infinity;
    this.firstAt = null;
    this.speechDb = null;
    this.skipUntil = nowMs + SETTLE_MS;
  }

  /** Feed one level report (RMS) taken at `nowMs`. Returns the new threshold
   *  when it moved enough to re-send to the gate, otherwise null. */
  push(rms: number, nowMs: number): number | null {
    if (rms <= SILENCE_RMS || nowMs < this.skipUntil) return null;
    const db = toDb(rms);
    if (this.firstAt === null) this.firstAt = nowMs;
    if (this.windowStart === null) {
      this.windowStart = nowMs;
    } else if (nowMs - this.windowStart >= SUBWINDOW_MS) {
      this.closed.push({ start: this.windowStart, minDb: this.windowMinDb });
      this.windowStart = nowMs;
      this.windowMinDb = Infinity;
    }
    this.windowMinDb = Math.min(this.windowMinDb, db);
    while (this.closed.length > 0 && this.closed[0]!.start <= nowMs - WINDOW_MS) {
      this.closed.shift();
    }
    if (nowMs - this.firstAt < WARMUP_MS) return null;

    if (db >= toDb(this.current) + SPEECH_ABOVE_DB) {
      this.speechDb =
        this.speechDb === null ? db : this.speechDb + SPEECH_ALPHA * (db - this.speechDb);
    }

    let floorDb = this.windowMinDb;
    for (const sub of this.closed) floorDb = Math.min(floorDb, sub.minDb);
    const low = Math.max(toDb(AUTO_MIN_THRESHOLD), floorDb + AUTO_MARGIN_DB);
    const high = this.speechDb === null ? low : this.speechDb - SPEECH_MARGIN_DB;
    const targetDb = low + Math.max(0, (high - low) / 2);
    const next = Math.min(AUTO_MAX_THRESHOLD, Math.max(AUTO_MIN_THRESHOLD, fromDb(targetDb)));
    if (Math.abs(toDb(next) - toDb(this.current)) < MOVE_DB) return null;
    this.current = next;
    return next;
  }
}
