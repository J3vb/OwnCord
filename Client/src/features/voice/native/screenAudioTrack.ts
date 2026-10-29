// Screen-share audio on Linux: the sound of the other applications is captured
// and published by the Rust session (`src-tauri/src/native_voice/share_audio.rs`),
// so the webview never holds a sample. `NativeScreenAudioTrack` stands in for
// the `LocalAudioTrack` that `createLocalScreenTracks` returns beside the video
// on the web path, so the shared screen-share code publishes, unpublishes and
// stops it like any other track of the share: `kind` and `source` route it,
// `stop()` releases the host side, and `mediaStreamTrack` is only the key the
// shared `unpublishManualTrack` passes to `NativeRoom.unpublishTrack`.
//
// Lifecycle: the shared screen-share state owns the track and stops it
// on disable/leave; `NativeRoom` also stops it when the share's capture ends
// and when it disconnects. stop() is idempotent and calls `onStop` once.

export class NativeScreenAudioTrack {
  readonly kind = "audio";
  readonly source = "screen_share_audio";
  private token: MediaStreamTrack | null = null;
  private stopped = false;

  /** `onStop` unpublishes the audio by sid (also one that lands later) and
   *  forgets the track. */
  constructor(private readonly onStop: (track: NativeScreenAudioTrack) => void) {}

  /** Whether `stop()` ran: a publish still in flight undoes itself. */
  get isStopped(): boolean {
    return this.stopped;
  }

  /** An identity token, never rendered: a canvas-capture track made on first
   *  use and stopped at once, so it holds no capture and no listener. */
  get mediaStreamTrack(): MediaStreamTrack {
    if (this.token === null) {
      const token = document.createElement("canvas").captureStream().getVideoTracks()[0]!;
      token.stop();
      this.token = token;
    }
    return this.token;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.onStop(this);
  }
}
