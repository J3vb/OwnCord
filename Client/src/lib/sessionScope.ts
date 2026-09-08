import { createLogger } from "./logger";

const log = createLogger("session");

/** Public ownership metadata. Credentials deliberately stay inside the API client. */
export interface SessionIdentity {
  readonly host: string;
  readonly generation: number;
}

/**
 * Owns asynchronous work and its cleanup. Capturing a scope before an await lets
 * consumers distinguish their original session from a later login to the same
 * host. Cancellation is also checked after completion: native APIs may finish
 * after their AbortSignal fires.
 */
export class SessionScope {
  readonly identity: Readonly<SessionIdentity>;
  private readonly controller = new AbortController();
  private readonly cleanups = new Set<() => void>();

  constructor(identity: SessionIdentity, parents: readonly AbortSignal[] = []) {
    this.identity = Object.freeze({ ...identity });
    for (const parent of parents) {
      if (parent.aborted) {
        this.dispose();
        break;
      }
      const onAbort = () => this.dispose();
      parent.addEventListener("abort", onAbort, { once: true });
      this.addCleanup(() => parent.removeEventListener("abort", onAbort));
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  isCurrent(): boolean {
    return !this.signal.aborted;
  }

  assertCurrent(): void {
    if (!this.isCurrent()) throw new DOMException("Session work was cancelled", "AbortError");
  }

  /** Register a listener/timer/resource disposer; the return value unregisters it. */
  addCleanup(cleanup: () => void): () => void {
    if (!this.isCurrent()) {
      this.cleanupSafely(cleanup);
      return () => {};
    }
    this.cleanups.add(cleanup);
    return () => this.cleanups.delete(cleanup);
  }

  /** A request/page can finish without cancelling its parent session. */
  fork(signal?: AbortSignal): SessionScope {
    return new SessionScope(this.identity, signal ? [this.signal, signal] : [this.signal]);
  }

  /** Reject promptly even when native work ignores cancellation or never returns. */
  run<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("Session work was cancelled", "AbortError"));
      this.signal.addEventListener("abort", onAbort, { once: true });
      // Always attach both handlers, including when already aborted, so a late
      // rejection from the underlying native task cannot become unhandled.
      work.then(
        (value) => {
          this.signal.removeEventListener("abort", onAbort);
          if (this.isCurrent()) resolve(value);
          else onAbort();
        },
        (error: unknown) => {
          this.signal.removeEventListener("abort", onAbort);
          if (this.isCurrent()) reject(error);
          else onAbort();
        },
      );
      if (!this.isCurrent()) onAbort();
    });
  }

  dispose(): void {
    if (!this.isCurrent()) return;
    this.controller.abort();
    const cleanups = [...this.cleanups];
    this.cleanups.clear();
    for (const cleanup of cleanups) this.cleanupSafely(cleanup);
  }

  private cleanupSafely(cleanup: () => void): void {
    try {
      cleanup();
    } catch {
      // One broken resource must not leave the remaining session resources live.
      log.warn("Session resource cleanup failed");
    }
  }
}
