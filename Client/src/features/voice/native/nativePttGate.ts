// The native room's push-to-talk gate, split from nativeRoom.ts. The Rust
// session's gate has no clock of its own, so a release's delay is a timer
// here: the gate stays open that long, and a press inside it cancels the
// close. The room owns one gate and settles it when its session ends.

/** Push-to-talk's state for a NativeRoom: whether the key is up (the session's
 *  open capture sends silence) and a release still waiting out its delay. */
export class NativePttGate {
  private closed = false;
  private release: ReturnType<typeof setTimeout> | undefined;

  /** `send` switches the live session's gate, when there is one. */
  constructor(private readonly send: (gated: boolean) => void) {}

  /** The gate a new capture opens behind (the key's last recorded state). */
  get gated(): boolean {
    return this.closed;
  }

  /** Close (key up) or open (key down) the gate. A close with
   *  `releaseDelayMs` keeps it open that long first. */
  set(gated: boolean, releaseDelayMs = 0): void {
    this.drop();
    if (gated && releaseDelayMs > 0 && !this.closed) {
      this.release = setTimeout(() => {
        this.release = undefined;
        this.apply(true);
      }, releaseDelayMs);
      return;
    }
    this.apply(gated);
  }

  /** The session ends: a close still waiting out its delay is recorded, not
   *  sent, so a later connect starts with the key's real state. */
  settle(): void {
    if (this.release === undefined) return;
    this.drop();
    this.closed = true;
  }

  private drop(): void {
    clearTimeout(this.release);
    this.release = undefined;
  }

  private apply(gated: boolean): void {
    if (this.closed === gated) return;
    this.closed = gated;
    this.send(gated);
  }
}
