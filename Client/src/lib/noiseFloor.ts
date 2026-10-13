// Automatic input sensitivity: a noise-floor estimate over the detector's
// level reports, and the gate threshold a fixed margin above it.
//
// The floor is the quietest level seen in the last WINDOW_MS (minimum
// statistics over 1 s sub-windows). A quieter level lowers it at once; a
// louder room lifts it once the quiet sub-windows age out. Speech cannot
// carry it: every pause between words reaches the room's own level, and one
// pause in the window is enough. Steady music or a fan does become the floor,
// which is the point: the user talks over it.

/** Margin of the gate threshold above the noise floor. */
export const AUTO_MARGIN_DB = 10;
/** Lowest automatic threshold (-60 dBFS, sensitivity 99 on the manual
 *  scale), so suppressed near-silence cannot let breathing open the gate. */
export const AUTO_MIN_THRESHOLD = 0.001;
/** Highest automatic threshold: today's default (sensitivity 50), so auto is
 *  never stricter than a fresh manual profile. */
export const AUTO_MAX_THRESHOLD = 0.05;

const SUBWINDOW_MS = 1000;
const WINDOW_MS = 8000;
/** Levels needed before the first estimate replaces the seed. */
const WARMUP_MS = 1000;
/** Reports ignored after an input-volume change, while its gain ramp settles. */
const SETTLE_MS = 200;
/** A smaller move than this is not worth re-sending to the gate. */
const MOVE_DB = 1;

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

  /** Forget the learned floor after the input volume moved: the levels behind
   *  the old gain (and its ramp) say nothing about the new one. The threshold
   *  holds until the new levels have been heard for the warm-up. */
  reset(nowMs: number): void {
    this.closed.length = 0;
    this.windowStart = null;
    this.windowMinDb = Infinity;
    this.firstAt = null;
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

    let floorDb = this.windowMinDb;
    for (const sub of this.closed) floorDb = Math.min(floorDb, sub.minDb);
    const next = Math.min(
      AUTO_MAX_THRESHOLD,
      Math.max(AUTO_MIN_THRESHOLD, fromDb(floorDb + AUTO_MARGIN_DB)),
    );
    if (Math.abs(toDb(next) - toDb(this.current)) < MOVE_DB) return null;
    this.current = next;
    return next;
  }
}
