import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ setPttGated: vi.fn() }));
vi.mock("../../lib/voice/livekitSession", () => ({ setPttGated: session.setPttGated }));

import {
  createTalkButton,
  pressTalk,
  releaseTalk,
  resetTalkButtonForTest,
  startTalkButton,
  syncTalkSource,
} from "./talkButton";
import { pttGates } from "../../lib/ui/inputMode";
import {
  isPttPollingLive,
  resetVoiceStore,
  setPttPollingLive,
  voiceStore,
} from "../../stores/voice.store";

const PREFIX = "owncord:settings:";
const setPref = (key: string, value: unknown): void =>
  localStorage.setItem(PREFIX + key, JSON.stringify(value));

/** Lets the lazy session import and its gate write settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const pointer = (type: string): Event =>
  Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    pointerId: 1,
    pointerType: "touch",
    button: 0,
  });

function joinCall(gated: boolean): void {
  voiceStore.setState((s) => ({ ...s, currentChannelId: 7, joinedAt: 1000, pttGated: gated }));
}

describe("talk button", () => {
  let owner: AbortController;

  beforeEach(() => {
    localStorage.clear();
    resetVoiceStore();
    session.setPttGated.mockReset();
    // The real session writes the store; the mock does it too.
    session.setPttGated.mockImplementation((gated: boolean) =>
      voiceStore.setState((s) => ({ ...s, pttGated: gated })),
    );
    owner = new AbortController();
  });

  afterEach(() => {
    owner.abort();
    resetTalkButtonForTest();
    setPttPollingLive(false);
  });

  it("makes Push to Talk gate on the button alone, with no key bound", () => {
    setPref("inputMode", "ptt");
    startTalkButton(owner.signal);
    expect(isPttPollingLive()).toBe(true);
    expect(pttGates(isPttPollingLive())).toBe(true);
  });

  it("reports no press source in Voice Activity mode", () => {
    setPref("inputMode", "vad");
    startTalkButton(owner.signal);
    expect(isPttPollingLive()).toBe(false);
  });

  it("opens the gate on press and closes it after the release delay", async () => {
    setPref("inputMode", "ptt");
    setPref("pttReleaseDelayMs", 100);
    startTalkButton(owner.signal);
    joinCall(true);

    pressTalk();
    await settle();
    expect(session.setPttGated).toHaveBeenLastCalledWith(false);

    releaseTalk();
    await settle();
    expect(session.setPttGated).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 150));
    expect(session.setPttGated).toHaveBeenLastCalledWith(true);
  });

  it("a press right after a release keeps the mic open", async () => {
    setPref("inputMode", "ptt");
    setPref("pttReleaseDelayMs", 200);
    startTalkButton(owner.signal);
    joinCall(true);

    pressTalk();
    await settle();
    releaseTalk();
    pressTalk();
    await new Promise((r) => setTimeout(r, 250));
    expect(session.setPttGated).not.toHaveBeenLastCalledWith(true);
    expect(voiceStore.getState().pttGated).toBe(false);
  });

  it("does nothing outside a call or in Voice Activity mode", async () => {
    setPref("inputMode", "ptt");
    startTalkButton(owner.signal);
    pressTalk();
    await settle();
    expect(session.setPttGated).not.toHaveBeenCalled();

    setPref("inputMode", "vad");
    syncTalkSource();
    joinCall(false);
    pressTalk();
    await settle();
    expect(session.setPttGated).not.toHaveBeenCalled();
  });

  it("a release whose delay outlives the call writes nothing to the next one", async () => {
    setPref("inputMode", "ptt");
    setPref("pttReleaseDelayMs", 100);
    startTalkButton(owner.signal);
    joinCall(true);
    pressTalk();
    await settle();
    session.setPttGated.mockClear();

    releaseTalk();
    await settle();
    voiceStore.setState((s) => ({ ...s, joinedAt: 2000 }));
    await new Promise((r) => setTimeout(r, 150));
    expect(session.setPttGated).not.toHaveBeenCalled();
  });

  it("closes the gate of a call in progress when Push to Talk is chosen, and opens it again for Voice Activity", async () => {
    setPref("inputMode", "vad");
    startTalkButton(owner.signal);
    joinCall(false);

    setPref("inputMode", "ptt");
    syncTalkSource();
    await settle();
    expect(isPttPollingLive()).toBe(true);
    expect(session.setPttGated).toHaveBeenLastCalledWith(true);

    setPref("inputMode", "vad");
    syncTalkSource();
    await settle();
    expect(isPttPollingLive()).toBe(false);
    expect(session.setPttGated).toHaveBeenLastCalledWith(false);
  });

  it("the app going to the background closes the gate", async () => {
    setPref("inputMode", "ptt");
    setPref("pttReleaseDelayMs", 0);
    startTalkButton(owner.signal);
    joinCall(true);
    pressTalk();
    await settle();

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
    } finally {
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
    }
    expect(session.setPttGated).toHaveBeenLastCalledWith(true);
  });

  describe("the button", () => {
    beforeEach(() => {
      setPref("inputMode", "ptt");
      setPref("pttReleaseDelayMs", 0);
      startTalkButton(owner.signal);
    });

    it("shows only in a call in Push to Talk mode", async () => {
      const btn = createTalkButton("call", owner.signal);
      expect(btn.hidden).toBe(true);
      joinCall(true);
      await settle();
      expect(btn.hidden).toBe(false);

      setPref("inputMode", "vad");
      syncTalkSource();
      await settle();
      expect(btn.hidden).toBe(true);
    });

    it("holding opens the mic and a cancelled touch closes it", async () => {
      joinCall(true);
      const btn = createTalkButton("bar", owner.signal);
      document.body.appendChild(btn);

      btn.dispatchEvent(pointer("pointerdown"));
      await settle();
      expect(session.setPttGated).toHaveBeenLastCalledWith(false);
      expect(btn.getAttribute("aria-pressed")).toBe("true");
      expect(btn.classList.contains("talking")).toBe(true);

      btn.dispatchEvent(pointer("pointercancel"));
      await settle();
      expect(session.setPttGated).toHaveBeenLastCalledWith(true);
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      btn.remove();
    });

    it("lifting the holding finger anywhere closes the mic, another finger does not", async () => {
      joinCall(true);
      const btn = createTalkButton("bar", owner.signal);
      document.body.appendChild(btn);
      btn.dispatchEvent(pointer("pointerdown"));
      await settle();

      const other = Object.assign(new Event("pointerup", { bubbles: true }), { pointerId: 2 });
      document.body.dispatchEvent(other);
      await settle();
      expect(session.setPttGated).toHaveBeenLastCalledWith(false);

      // The button was redrawn away from under the finger: the lift still counts.
      btn.remove();
      document.body.dispatchEvent(pointer("pointerup"));
      await settle();
      expect(session.setPttGated).toHaveBeenLastCalledWith(true);
    });

    it("letting go closes the mic", async () => {
      joinCall(true);
      const btn = createTalkButton("call", owner.signal);
      btn.dispatchEvent(pointer("pointerdown"));
      await settle();
      btn.dispatchEvent(pointer("pointerup"));
      await settle();
      expect(session.setPttGated).toHaveBeenLastCalledWith(true);
    });

    it("is disabled and opens nothing while muted", async () => {
      joinCall(true);
      voiceStore.setState((s) => ({ ...s, localMuted: true }));
      const btn = createTalkButton("bar", owner.signal);
      expect(btn.disabled).toBe(true);
      btn.dispatchEvent(pointer("pointerdown"));
      await settle();
      expect(session.setPttGated).not.toHaveBeenCalled();
    });

    it("muting while holding closes the gate", async () => {
      joinCall(true);
      const btn = createTalkButton("bar", owner.signal);
      btn.dispatchEvent(pointer("pointerdown"));
      await settle();
      voiceStore.setState((s) => ({ ...s, localMuted: true }));
      await settle();
      expect(session.setPttGated).toHaveBeenLastCalledWith(true);
    });

    it("taking the button down while it is held closes the gate", async () => {
      joinCall(true);
      const own = new AbortController();
      const btn = createTalkButton("call", own.signal);
      btn.dispatchEvent(pointer("pointerdown"));
      await settle();
      own.abort();
      await settle();
      expect(session.setPttGated).toHaveBeenLastCalledWith(true);
    });

    it("Space held on the focused button talks, and letting go stops", async () => {
      joinCall(true);
      const btn = createTalkButton("call", owner.signal);
      btn.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      await settle();
      expect(session.setPttGated).toHaveBeenLastCalledWith(false);
      btn.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
      await settle();
      expect(session.setPttGated).toHaveBeenLastCalledWith(true);
    });
  });
});
