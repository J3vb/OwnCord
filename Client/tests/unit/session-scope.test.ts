import { describe, expect, it, vi } from "vitest";
import { SessionScope } from "../../src/lib/sessionScope";

describe("SessionScope", () => {
  it("invalidates identity before cleanup and cleans all resources exactly once", () => {
    const scope = new SessionScope({ host: "first.example", generation: 1 });
    const calls: string[] = [];
    scope.addCleanup(() => {
      expect(scope.isCurrent()).toBe(false);
      calls.push("listener");
      throw new Error("broken cleanup");
    });
    scope.addCleanup(() => calls.push("timer"));
    const unregister = scope.addCleanup(() => calls.push("already released"));
    unregister();
    scope.dispose();
    scope.dispose();
    expect(calls).toEqual(["listener", "timer"]);
    const late = vi.fn();
    scope.addCleanup(late);
    expect(late).toHaveBeenCalledOnce();
    expect(Object.isFrozen(scope.identity)).toBe(true);
  });

  it("cancels children without cancelling siblings on child completion", () => {
    const parent = new SessionScope({ host: "first.example", generation: 1 });
    const first = parent.fork();
    const second = parent.fork();
    first.dispose();
    expect(parent.isCurrent()).toBe(true);
    expect(second.isCurrent()).toBe(true);
    parent.dispose();
    expect(second.signal.aborted).toBe(true);
  });

  it("rejects promptly when native work ignores abort and consumes its late rejection", async () => {
    const scope = new SessionScope({ host: "first.example", generation: 1 });
    let reject!: (reason: unknown) => void;
    const native = new Promise<string>((_yes, no) => {
      reject = no;
    });
    const result = scope.run(native);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    scope.dispose();
    await rejected;
    reject(new Error("late native failure"));
    await Promise.resolve();
  });

  it("rejects resolved work if cancellation wins before its continuation", async () => {
    const scope = new SessionScope({ host: "first.example", generation: 1 });
    const result = scope.run(Promise.resolve("old account"));
    scope.dispose();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  it("links caller cancellation and handles already aborted parents", () => {
    const caller = new AbortController();
    const parent = new SessionScope({ host: "first.example", generation: 1 });
    const child = parent.fork(caller.signal);
    caller.abort();
    expect(child.isCurrent()).toBe(false);
    expect(parent.isCurrent()).toBe(true);
    expect(parent.fork(caller.signal).isCurrent()).toBe(false);
  });
});
