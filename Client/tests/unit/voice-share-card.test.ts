// The voice widget's share card while you share (voiceWidget/streamCard.ts)
// and its host (widget/streamCardHost.ts): what the card shows, the Quality
// segments, and the share button, which under Deck on a desktop opens the
// card instead of stopping the share.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";
import * as voiceSession from "../helpers/voiceSessionMock";
import * as voiceWidget from "../helpers/voiceWidgetHarness";
import { usePhone } from "../helpers/phoneMedia";

const share = vi.hoisted(() => ({
  quality: "medium" as string | null,
  audio: true,
  canChange: true,
  setQuality: (() => Promise.resolve()) as (q: string) => Promise<void>,
  stream: null as unknown,
}));

vi.mock("../../src/lib/hostOs", () => ({
  isLinuxDesktop: () => false,
  isWindowsDesktop: () => false,
  canPublishScreen: () => true,
}));
vi.mock("../../src/features/voice/livekitSession", () =>
  voiceSession.withOverrides({
    getLocalScreenshareStream: () => share.stream,
    getScreenshareQuality: () => share.quality,
    canChangeScreenshareSource: () => share.canChange,
    setScreenshareQuality: (q: string) => share.setQuality(q),
    hasLocalScreenshareAudio: () => share.audio,
  }),
);
vi.mock("@lib/voice/connectionStats", () => voiceWidget.connectionStatsMock(true));

import { createVoiceWidget } from "../../src/features/voice/VoiceWidget";
import { registerVideoSurface } from "../../src/lib/voice/videoSurface";
import { voiceStore } from "../../src/stores/voice.store";
import { setConnectionStatus, uiStore } from "../../src/stores/ui.store";

/** A captured window the way Chromium reports one: titled, 1044p at 29 fps. */
function windowStream(label = "Like Going Back In Time · YouTube") {
  const track = {
    id: "share-1",
    label,
    getSettings: () => ({ displaySurface: "window", height: 1044, frameRate: 29.4 }),
  };
  return { getVideoTracks: () => [track], getAudioTracks: () => [] };
}

describe("the share card", () => {
  let container: HTMLDivElement;
  let toggle: ReturnType<typeof vi.fn<() => void>>;
  let widget: ReturnType<typeof createVoiceWidget> | null = null;

  useMountContainer((c) => {
    container = c;
  });

  beforeEach(() => {
    voiceWidget.resetVoiceWidgetStores();
    Object.assign(share, {
      quality: "medium",
      audio: true,
      canChange: true,
      setQuality: () => Promise.resolve(),
      stream: windowStream(),
    });
    toggle = vi.fn<() => void>();
  });

  afterEach(() => {
    widget?.destroy?.();
    widget = null;
    document.documentElement.classList.remove("layout-deck");
    vi.unstubAllGlobals();
  });

  async function startSharing(sharing = true): Promise<void> {
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 1, localScreenshare: sharing }));
    voiceStore.flush();
    widget ??= createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: toggle,
    });
    if (container.childElementCount === 0) widget.mount(container);
    await vi.dynamicImportSettled();
  }

  it("never shows a card for a share that ended before the card loaded", async () => {
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 1, localScreenshare: true }));
    voiceStore.flush();
    widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: toggle,
    });
    widget.mount(container);
    // The card's module is still loading when the share stops.
    stopSharingElsewhere();
    await vi.dynamicImportSettled();
    expect(card()).toBeNull();
  });

  function stopSharingElsewhere(): void {
    voiceStore.setState((prev) => ({ ...prev, localScreenshare: false }));
    voiceStore.flush();
  }

  const card = () => container.querySelector<HTMLElement>("[data-testid='vw-stream-card']");
  const shareBtn = () => container.querySelector<HTMLButtonElement>(".vw-share-btn")!;
  const chips = () =>
    [...card()!.querySelectorAll("[data-testid='vw-stream-chips'] .vw-chip")].map(
      (c) => c.textContent,
    );
  const segment = (q: string) =>
    card()!.querySelector<HTMLButtonElement>(`.vw-quality-seg[data-quality="${q}"]`)!;
  const checked = () =>
    card()!.querySelector<HTMLElement>(".vw-quality-seg[aria-checked='true']")?.dataset["quality"];

  describe("content", () => {
    it("says what is going out: LIVE, the kind of source, its name and its format", async () => {
      await startSharing();
      const el = card()!;
      expect(el.querySelector(".vw-live-badge")!.textContent).toBe("LIVE");
      expect(el.querySelector(".vw-card-eyebrow")!.textContent).toBe("Screen share");
      expect(el.querySelector(".vw-card-title")!.textContent).toBe("You're sharing a window");
      const sub = el.querySelector<HTMLElement>(".vw-card-sub")!;
      expect(sub.textContent).toBe("Like Going Back In Time · YouTube");
      expect(sub.hidden).toBe(false);
      // Height and the rounded rate as plain numbers, then audio; no encoder.
      expect(chips()).toEqual(["1044p", "29 fps", "Audio on"]);
    });

    it("leaves the name out where the capture only carries its id, and says audio is off", async () => {
      share.stream = windowStream("window:42:0");
      share.audio = false;
      await startSharing();
      expect(card()!.querySelector<HTMLElement>(".vw-card-sub")!.hidden).toBe(true);
      expect(card()!.textContent).not.toContain("window:42:0");
      expect(chips()).toEqual(["1044p", "29 fps", "Audio off"]);
    });

    it("plays a muted preview of the share, and Hide preview stops only the picture", async () => {
      await startSharing();
      const preview = card()!.querySelector<HTMLElement>(".vw-share-preview")!;
      const video = preview.querySelector("video")!;
      const hide = card()!.querySelector<HTMLButtonElement>(
        "[data-testid='vw-stream-preview-toggle']",
      )!;
      expect(preview.hidden).toBe(false);
      expect(video.muted).toBe(true);
      expect(video.srcObject).toBe(share.stream);
      expect(hide.textContent).toBe("Hide preview");

      hide.click();
      expect(video.srcObject).toBeNull();
      expect(preview.classList.contains("vw-share-preview--off")).toBe(true);
      expect(hide.textContent).toBe("Show preview");
      expect(hide.getAttribute("aria-pressed")).toBe("true");
      expect(toggle).not.toHaveBeenCalled();
      expect(card()).not.toBeNull();

      // Redraws keep it hidden until it is asked back.
      voiceStore.setState((prev) => ({ ...prev, localMuted: true }));
      voiceStore.flush();
      expect(video.srcObject).toBeNull();
      hide.click();
      expect(video.srcObject).toBe(share.stream);
    });

    it("keeps the same picture playing across redraws of the same share", async () => {
      await startSharing();
      const video = card()!.querySelector("video")!;
      const first = video.srcObject;
      // The session hands out a new stream object for the same track.
      share.stream = windowStream();
      voiceStore.setState((prev) => ({ ...prev, localMuted: true }));
      voiceStore.flush();
      expect(video.srcObject).toBe(first);
    });

    it("hides the preview where the share has no picture in this page", async () => {
      share.stream = { getVideoTracks: () => [], getAudioTracks: () => [] };
      await startSharing();
      expect(card()!.querySelector<HTMLElement>(".vw-share-preview")!.hidden).toBe(true);
      expect(card()!.querySelector("video")!.srcObject ?? null).toBeNull();
      expect(chips()).toEqual(["Audio on"]);
    });

    it("hides the preview where our own renderer draws the picture (Linux native)", async () => {
      const stream = windowStream();
      registerVideoSurface(
        stream.getVideoTracks()[0] as unknown as MediaStreamTrack,
        document.createElement("canvas"),
      );
      share.stream = stream;
      await startSharing();
      expect(card()!.querySelector<HTMLElement>(".vw-share-preview")!.hidden).toBe(true);
      expect(card()!.querySelector("video")!.srcObject ?? null).toBeNull();
    });

    it("lets go of the picture when the card goes", async () => {
      await startSharing();
      const video = card()!.querySelector("video")!;
      stopSharingElsewhere();
      expect(video.srcObject).toBeNull();
    });
  });

  describe("Quality", () => {
    it("is a radio group of four segments, each with its resolution", async () => {
      await startSharing();
      const group = card()!.querySelector<HTMLElement>("[data-testid='vw-stream-quality']")!;
      expect(group.getAttribute("role")).toBe("radiogroup");
      const segs = [...group.querySelectorAll<HTMLElement>("[role='radio']")];
      expect(segs.map((s) => s.querySelector(".vw-quality-name")!.textContent)).toEqual([
        "Low",
        "Medium",
        "High",
        "Source",
      ]);
      expect(segs.map((s) => s.querySelector(".vw-quality-res")!.textContent)).toEqual([
        "720p · 5 fps",
        "720p",
        "1080p",
        "Native",
      ]);
      // One tab stop: the checked segment.
      expect(segs.map((s) => s.tabIndex)).toEqual([-1, 0, -1, -1]);
      expect(checked()).toBe("medium");
    });

    it("moves the choice with the arrow keys, wrapping at the ends", async () => {
      const setQuality = vi.fn((q: string) => {
        share.quality = q;
        return Promise.resolve();
      });
      share.setQuality = setQuality;
      await startSharing();
      const group = card()!.querySelector<HTMLElement>("[data-testid='vw-stream-quality']")!;

      group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      expect(setQuality).toHaveBeenLastCalledWith("high");
      expect(document.activeElement).toBe(segment("high"));
      await vi.waitFor(() => expect(group.getAttribute("aria-busy")).toBe("false"));

      group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      expect(setQuality).toHaveBeenLastCalledWith("source");
      await vi.waitFor(() => expect(group.getAttribute("aria-busy")).toBe("false"));

      group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      expect(setQuality).toHaveBeenLastCalledWith("low");
      await vi.waitFor(() => expect(group.getAttribute("aria-busy")).toBe("false"));

      group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      expect(setQuality).toHaveBeenLastCalledWith("source");
      await vi.waitFor(() => expect(group.getAttribute("aria-busy")).toBe("false"));
      group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      expect(setQuality).toHaveBeenLastCalledWith("high");

      // Other keys are the page's.
      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      group.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(false);
      expect(setQuality).toHaveBeenCalledTimes(5);
    });

    it("ignores picks while a change is applied, and keeps the segments focusable", async () => {
      let finish: () => void = () => {};
      const setQuality = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
      share.setQuality = setQuality;
      await startSharing();
      segment("high").click();
      expect(segment("high").getAttribute("aria-disabled")).toBe("true");
      expect(segment("high").disabled).toBe(false);
      segment("low").click();
      card()!
        .querySelector("[data-testid='vw-stream-quality']")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      expect(setQuality).toHaveBeenCalledTimes(1);
      finish();
      await vi.waitFor(() => expect(segment("high").getAttribute("aria-disabled")).toBe("false"));
    });

    it("does nothing on a click of the segment already chosen", async () => {
      const setQuality = vi.fn(() => Promise.resolve());
      share.setQuality = setQuality;
      await startSharing();
      segment("medium").click();
      expect(setQuality).not.toHaveBeenCalled();
    });

    it("puts the live quality back when the change is refused", async () => {
      // The host settles without taking it: the live quality stays medium.
      share.setQuality = () => Promise.resolve();
      await startSharing();
      segment("source").click();
      expect(checked()).toBe("source");
      await vi.waitFor(() => expect(checked()).toBe("medium"));
    });

    it("is hidden with its label where the share has no quality", async () => {
      share.quality = null;
      await startSharing();
      expect(card()!.querySelector<HTMLElement>("[data-testid='vw-stream-quality']")!.hidden).toBe(
        true,
      );
      const label = [...card()!.querySelectorAll<HTMLElement>(".vw-card-eyebrow")].find(
        (e) => e.textContent === "Quality",
      )!;
      expect(label.hidden).toBe(true);
    });
  });

  describe("the share button", () => {
    it("stops the share in Classic, with no popup on it", async () => {
      await startSharing();
      expect(card()!.classList.contains("vw-pop")).toBe(false);
      expect(shareBtn().hasAttribute("aria-haspopup")).toBe(false);
      expect(shareBtn().hasAttribute("aria-expanded")).toBe(false);
      expect(shareBtn().title).toBe("Stop sharing");
      shareBtn().click();
      expect(toggle).toHaveBeenCalledOnce();
    });

    it("stops the share on a phone under Deck too", async () => {
      document.documentElement.classList.add("layout-deck");
      usePhone();
      await startSharing();
      shareBtn().click();
      expect(toggle).toHaveBeenCalledOnce();
      expect(card()!.classList.contains("vw-pop")).toBe(false);
    });

    it("starts a share under Deck while nothing is shared", async () => {
      document.documentElement.classList.add("layout-deck");
      await startSharing(false);
      expect(card()).toBeNull();
      expect(shareBtn().hasAttribute("aria-haspopup")).toBe(false);
      shareBtn().click();
      expect(toggle).toHaveBeenCalledOnce();
    });

    it("opens and closes the card under Deck while sharing; Stop is in the card", async () => {
      document.documentElement.classList.add("layout-deck");
      await startSharing();
      const el = card()!;
      expect(el.classList.contains("vw-pop")).toBe(true);
      expect(el.getAttribute("role")).toBe("dialog");
      expect(el.classList.contains("vw-pop--open")).toBe(false);
      expect(shareBtn().getAttribute("aria-haspopup")).toBe("dialog");
      expect(shareBtn().getAttribute("aria-expanded")).toBe("false");
      expect(shareBtn().title).toBe("Screen share: quality, source, stop");

      shareBtn().click();
      expect(el.classList.contains("vw-pop--open")).toBe(true);
      expect(shareBtn().getAttribute("aria-expanded")).toBe("true");
      shareBtn().click();
      expect(el.classList.contains("vw-pop--open")).toBe(false);
      expect(toggle).not.toHaveBeenCalled();

      shareBtn().click();
      el.querySelector<HTMLButtonElement>("[data-testid='vw-stream-stop']")!.click();
      expect(toggle).toHaveBeenCalledOnce();
    });

    it("closes the card on Esc and on a click outside it", async () => {
      document.documentElement.classList.add("layout-deck");
      await startSharing();
      shareBtn().click();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(card()!.classList.contains("vw-pop--open")).toBe(false);
      expect(document.activeElement).toBe(shareBtn());

      shareBtn().click();
      card()!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      expect(card()!.classList.contains("vw-pop--open")).toBe(true);
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      expect(card()!.classList.contains("vw-pop--open")).toBe(false);
    });

    it("closes the open card and puts the button back when the share stops elsewhere", async () => {
      document.documentElement.classList.add("layout-deck");
      await startSharing();
      shareBtn().dispatchEvent(new MouseEvent("click", { detail: 1 }));
      expect(card()!.classList.contains("vw-pop--open")).toBe(true);
      document.body.focus();

      // The shared window closed, or Stop on the tile.
      stopSharingElsewhere();
      expect(card()).toBeNull();
      expect(shareBtn().hasAttribute("aria-haspopup")).toBe(false);
      expect(shareBtn().hasAttribute("aria-expanded")).toBe(false);
      expect(shareBtn().getAttribute("aria-pressed")).toBe("false");
      expect(shareBtn().title).toBe("Share your screen");
      // Its Esc and outside-click listeners went with it.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(document.activeElement).not.toBe(shareBtn());

      // The next press starts a new share rather than opening a card.
      shareBtn().click();
      expect(toggle).toHaveBeenCalledOnce();
    });

    it("gives the focus back to the share button when Stop in the card ends the share", async () => {
      document.documentElement.classList.add("layout-deck");
      toggle.mockImplementation(stopSharingElsewhere);
      await startSharing();
      shareBtn().dispatchEvent(new MouseEvent("click", { detail: 1 }));
      const stop = card()!.querySelector<HTMLButtonElement>("[data-testid='vw-stream-stop']")!;
      stop.focus();
      stop.click();
      expect(card()).toBeNull();
      expect(document.activeElement).toBe(shareBtn());
    });

    it("moves the focus into the card when the keyboard opens it, not the pointer", async () => {
      document.documentElement.classList.add("layout-deck");
      await startSharing();
      shareBtn().dispatchEvent(new MouseEvent("click", { detail: 1 }));
      expect(card()!.contains(document.activeElement)).toBe(false);
      shareBtn().dispatchEvent(new MouseEvent("click", { detail: 1 }));

      // A keyboard press is a click with no pointer (detail 0).
      shareBtn().focus();
      shareBtn().dispatchEvent(new MouseEvent("click", { detail: 0 }));
      expect(document.activeElement).toBe(segment("medium"));
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      expect(card()!.classList.contains("vw-pop--open")).toBe(false);
      expect(document.activeElement).toBe(shareBtn());
    });

    it("closes the connection card when the share card opens, and the other way round", async () => {
      document.documentElement.classList.add("layout-deck");
      await startSharing();
      const stats = container.querySelector<HTMLElement>("[data-testid='vw-stats']")!;
      const signal = container.querySelector<HTMLButtonElement>(".vw-signal")!;
      signal.dispatchEvent(new MouseEvent("click", { detail: 1 }));
      expect(stats.classList.contains("visible")).toBe(true);
      shareBtn().dispatchEvent(new MouseEvent("click", { detail: 0 }));
      expect(stats.classList.contains("visible")).toBe(false);
      expect(card()!.classList.contains("vw-pop--open")).toBe(true);
      signal.dispatchEvent(new MouseEvent("click", { detail: 0 }));
      expect(card()!.classList.contains("vw-pop--open")).toBe(false);
      expect(stats.classList.contains("visible")).toBe(true);
      expect(signal.getAttribute("aria-expanded")).toBe("true");
      expect(shareBtn().getAttribute("aria-expanded")).toBe("false");
    });

    it("plays the preview only while the Deck card is open", async () => {
      document.documentElement.classList.add("layout-deck");
      await startSharing();
      const video = card()!.querySelector("video")!;
      expect(video.srcObject ?? null).toBeNull();
      shareBtn().click();
      expect(video.srcObject).toBe(share.stream);
      shareBtn().click();
      expect(video.srcObject).toBeNull();
    });

    it("plays the preview again when the phone layout starts with the Deck card closed", async () => {
      document.documentElement.classList.add("layout-deck");
      let phone = false;
      const changes: (() => void)[] = [];
      vi.stubGlobal(
        "matchMedia",
        vi.fn((q: string) => ({
          matches: phone && q.includes("pointer: coarse"),
          addEventListener: (_type: string, fn: () => void) => changes.push(fn),
        })),
      );
      await startSharing();
      const video = card()!.querySelector("video")!;
      expect(video.srcObject ?? null).toBeNull();
      // Upright again: the card is inline, always on screen, so it plays.
      phone = true;
      for (const fn of changes) fn();
      expect(video.srcObject).toBe(share.stream);
    });

    it("is no toggle while it opens the card: no aria-pressed there, as in Classic", async () => {
      await startSharing();
      expect(shareBtn().getAttribute("aria-pressed")).toBe("true");
      widget?.destroy?.();
      widget = null;
      container.replaceChildren();
      document.documentElement.classList.add("layout-deck");
      await startSharing();
      expect(shareBtn().hasAttribute("aria-pressed")).toBe(false);
      expect(shareBtn().getAttribute("aria-expanded")).toBe("false");
    });

    it("stays live while the chat connection is down, so the card is reachable", async () => {
      document.documentElement.classList.add("layout-deck");
      await startSharing();
      setConnectionStatus("reconnecting");
      uiStore.flush();
      expect(shareBtn().disabled).toBe(false);
      expect(shareBtn().title).toBe("Screen share: quality, source, stop");
      expect(container.querySelector<HTMLButtonElement>("[aria-label='Camera']")!.disabled).toBe(
        true,
      );
      shareBtn().click();
      expect(card()!.classList.contains("vw-pop--open")).toBe(true);
    });

    it("is frozen with the chat connection down in Classic, as before", async () => {
      await startSharing();
      setConnectionStatus("reconnecting");
      uiStore.flush();
      expect(shareBtn().disabled).toBe(true);
      expect(shareBtn().title).toBe("Reconnecting…");
    });

    it("comes back closed for the next share", async () => {
      document.documentElement.classList.add("layout-deck");
      await startSharing();
      shareBtn().click();
      stopSharingElsewhere();
      await startSharing();
      expect(card()!.classList.contains("vw-pop--open")).toBe(false);
      expect(shareBtn().getAttribute("aria-expanded")).toBe("false");
    });
  });
});
