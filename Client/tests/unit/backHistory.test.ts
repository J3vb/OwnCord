import { afterEach, describe, expect, it, vi } from "vitest";
import { claimBack, holdBackGuard } from "../../src/lib/ui/backHistory";
import { runSessionResets } from "../../src/lib/net/sessionRegistry";
import { guarded as onEntry, pressBack, settle } from "../helpers/backNav";

const owners: AbortController[] = [];
function owner(): AbortController {
  const ac = new AbortController();
  owners.push(ac);
  return ac;
}

afterEach(async () => {
  for (const ac of owners.splice(0)) ac.abort();
  await settle();
  vi.restoreAllMocks();
});

describe("claimBack", () => {
  it("holds one history entry while claimed and Back runs onBack", async () => {
    const onBack = vi.fn();
    claimBack(onBack, owner().signal);
    expect(onEntry()).toBe(true);
    await pressBack();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onEntry()).toBe(false);
  });

  it("closes the claim made last, one Back at a time", async () => {
    const calls: string[] = [];
    const first = owner();
    const second = owner();
    claimBack(() => calls.push("first"), first.signal);
    claimBack(() => calls.push("second"), second.signal);
    await pressBack();
    expect(calls).toEqual(["second"]);
    // The first claim still has its entry: Back again closes it.
    expect(onEntry()).toBe(true);
    await pressBack();
    expect(calls).toEqual(["second", "first"]);
    expect(onEntry()).toBe(false);
  });

  it("pushes one entry however many claims share it", () => {
    const push = vi.spyOn(history, "pushState");
    claimBack(() => undefined, owner().signal);
    claimBack(() => undefined, owner().signal);
    claimBack(() => undefined, owner().signal);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("releasing pops the entry without calling onBack, and does not pop twice", async () => {
    const onBack = vi.fn();
    const back = vi.spyOn(history, "back");
    const ac = owner();
    const claim = claimBack(onBack, ac.signal);
    claim.release();
    claim.release();
    ac.abort();
    await settle();
    expect(back).toHaveBeenCalledTimes(1);
    expect(onBack).not.toHaveBeenCalled();
    expect(onEntry()).toBe(false);
  });

  it("does not double-pop when a claim closes itself from onBack", async () => {
    const back = vi.spyOn(history, "back");
    const ac = owner();
    const claim = claimBack(() => claim.release(), ac.signal);
    await pressBack();
    // Only the user's own Back: nothing of ours was added to it.
    expect(back).toHaveBeenCalledTimes(1);
    expect(onEntry()).toBe(false);
  });

  it("keeps the entry for the claims that remain after one is released", async () => {
    const back = vi.spyOn(history, "back");
    const a = claimBack(() => undefined, owner().signal);
    claimBack(() => undefined, owner().signal);
    a.release();
    await settle();
    expect(back).not.toHaveBeenCalled();
    expect(onEntry()).toBe(true);
  });

  it("a claim made while an earlier release's back is in flight waits for it", async () => {
    const first = claimBack(() => undefined, owner().signal);
    first.release();
    // The release's history.back() has not landed yet.
    const onBack = vi.fn();
    claimBack(onBack, owner().signal);
    await settle();
    expect(onBack).not.toHaveBeenCalled();
    expect(onEntry()).toBe(true);
    await pressBack();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("claims nothing for a signal already aborted", () => {
    const ac = new AbortController();
    ac.abort();
    const push = vi.spyOn(history, "pushState");
    claimBack(() => undefined, ac.signal);
    expect(push).not.toHaveBeenCalled();
  });

  it("ignores a popstate that leaves the entry on top, and one it did not cause", async () => {
    const onBack = vi.fn();
    claimBack(onBack, owner().signal);
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    // jsdom's state still carries our key, so nothing was popped.
    expect(onBack).not.toHaveBeenCalled();
    expect(onEntry()).toBe(true);
  });

  it("a session reset drops every claim and the guard, and pops the entry", async () => {
    const onBack = vi.fn();
    const onGuard = vi.fn();
    claimBack(onBack, owner().signal);
    const guard = holdBackGuard(onGuard, owner().signal);
    guard.setActive(true);
    runSessionResets("server_switch");
    await settle();
    expect(onEntry()).toBe(false);
    await pressBack();
    expect(onBack).not.toHaveBeenCalled();
    expect(onGuard).not.toHaveBeenCalled();
  });
});

describe("a reload", () => {
  it("unmarks an entry an earlier page load left on top, so the next Back still counts", async () => {
    history.pushState({ owncordBack: true }, "");
    vi.resetModules();
    // Only the module under test loads again, not the session registry's graph.
    vi.doMock("../../src/lib/net/sessionRegistry", () => ({
      registerSessionReset: () => undefined,
    }));
    const fresh = await import("../../src/lib/ui/backHistory");
    vi.doUnmock("../../src/lib/net/sessionRegistry");
    expect(onEntry()).toBe(false);
    const onBack = vi.fn();
    fresh.claimBack(onBack, owner().signal);
    await pressBack();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("abort listeners", () => {
  it("a released claim and guard leave no listener on their signal", () => {
    const ac = owner();
    const remove = vi.spyOn(ac.signal, "removeEventListener");
    claimBack(vi.fn(), ac.signal).release();
    holdBackGuard(vi.fn(), ac.signal).release();
    expect(remove).toHaveBeenCalledTimes(2);
  });
});

describe("holdBackGuard", () => {
  it("holds an entry only while active, and Back runs its action", async () => {
    const onBack = vi.fn();
    const guard = holdBackGuard(onBack, owner().signal);
    expect(onEntry()).toBe(false);
    guard.setActive(true);
    expect(onEntry()).toBe(true);
    // The action turns the guard off, as opening the drawer does: no entry is
    // left, so a further Back is the system's.
    onBack.mockImplementation(() => guard.setActive(false));
    await pressBack();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onEntry()).toBe(false);
    await pressBack();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("goes back up when set active again", async () => {
    const guard = holdBackGuard(() => guard.setActive(false), owner().signal);
    guard.setActive(true);
    await pressBack();
    expect(onEntry()).toBe(false);
    guard.setActive(true);
    expect(onEntry()).toBe(true);
  });

  it("stays up when its action does not turn it off", async () => {
    const onBack = vi.fn();
    const guard = holdBackGuard(onBack, owner().signal);
    guard.setActive(true);
    await pressBack();
    expect(onBack).toHaveBeenCalledTimes(1);
    // Re-armed: the next Back lands in the action again.
    expect(onEntry()).toBe(true);
  });

  it("is not asked while a claim is open: the claim closes first, then the guard holds", async () => {
    const onGuard = vi.fn();
    const onClaim = vi.fn();
    const guard = holdBackGuard(onGuard, owner().signal);
    guard.setActive(true);
    claimBack(onClaim, owner().signal);
    await pressBack();
    expect(onClaim).toHaveBeenCalledTimes(1);
    expect(onGuard).not.toHaveBeenCalled();
    // The claim's Back took the entry; the guard puts its own back.
    expect(onEntry()).toBe(true);
    await pressBack();
    expect(onGuard).toHaveBeenCalledTimes(1);
  });

  it("keeps the entry across a claim coming and going (no pop and push)", async () => {
    const back = vi.spyOn(history, "back");
    const guard = holdBackGuard(() => undefined, owner().signal);
    guard.setActive(true);
    const claim = claimBack(() => undefined, owner().signal);
    claim.release();
    await settle();
    expect(back).not.toHaveBeenCalled();
    expect(onEntry()).toBe(true);
  });

  it("an inactive guard is not asked", async () => {
    const onGuard = vi.fn();
    const guard = holdBackGuard(onGuard, owner().signal);
    guard.setActive(true);
    guard.setActive(false);
    await settle();
    await pressBack();
    expect(onGuard).not.toHaveBeenCalled();
  });

  it("a released guard holds nothing and cannot be turned on", async () => {
    const guard = holdBackGuard(() => undefined, owner().signal);
    guard.setActive(true);
    guard.release();
    await settle();
    expect(onEntry()).toBe(false);
    guard.setActive(true);
    expect(onEntry()).toBe(false);
  });

  it("one guard at a time: a newer one replaces the old", async () => {
    const oldGuard = vi.fn();
    const newGuard = vi.fn();
    const a = holdBackGuard(oldGuard, owner().signal);
    const b = holdBackGuard(newGuard, owner().signal);
    a.setActive(true);
    expect(onEntry()).toBe(false);
    b.setActive(true);
    await pressBack();
    expect(newGuard).toHaveBeenCalledTimes(1);
    expect(oldGuard).not.toHaveBeenCalled();
  });
});
