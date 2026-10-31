import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePhone } from "../helpers/phoneMedia";

// The shared Back history, replaced by a stub that records the claims.
const back = vi.hoisted(() => ({ onBack: [] as Array<() => void>, released: 0 }));
vi.mock("../../src/lib/ui/backHistory", () => ({
  claimBack: (onBack: () => void) => {
    back.onBack.push(onBack);
    return {
      release: () => {
        back.released += 1;
      },
    };
  },
}));

import {
  createIncomingCallBanner,
  type IncomingCallBannerComponent,
} from "../../src/components/IncomingCallBanner";
import type { RingState } from "../../src/lib/voice/callRing";

const RING: RingState = { channelId: 100, fromUserId: 2, fromUsername: "Otto" };

describe("incoming call on a phone", () => {
  let host: HTMLDivElement;
  let banner: IncomingCallBannerComponent;
  const onAccept = vi.fn<(withVideo: boolean) => void>();
  const onDecline = vi.fn<() => void>();

  const bannerEl = (): HTMLElement =>
    host.querySelector<HTMLElement>("[data-testid='incoming-call-banner']")!;
  const screenEl = (): HTMLElement | null =>
    document.querySelector<HTMLElement>("[data-testid='incoming-call-screen']");
  const q = (id: string): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>(`[data-testid='${id}']`)!;
  const screenUp = async (): Promise<void> => {
    await vi.waitFor(() => expect(screenEl()).not.toBeNull());
  };
  /** Long enough for a view that was not going to open to have opened. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  beforeEach(() => {
    back.onBack.length = 0;
    back.released = 0;
    onAccept.mockReset();
    onDecline.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    banner = createIncomingCallBanner({ onAccept, onDecline });
    banner.mount(host);
  });

  afterEach(() => {
    banner.destroy?.();
    host.remove();
    vi.unstubAllGlobals();
  });

  it("takes the whole screen with the caller, Decline and Accept", async () => {
    usePhone(true);
    banner.setRing(RING);
    await screenUp();

    expect(screenEl()!.getAttribute("role")).toBe("dialog");
    expect(q("incoming-call-screen-title").textContent).toBe("Otto is calling");
    expect(screenEl()!.textContent).toContain("Incoming call");
    expect(q("incoming-call-screen-avatar")).not.toBeNull();
    expect(q("incoming-call-screen-accept")).not.toBeNull();
    expect(q("incoming-call-screen-decline")).not.toBeNull();
    expect(q("incoming-call-screen-accept-video").textContent).toBe("Join with video");
    // One answer surface: the banner steps aside.
    expect(bannerEl().style.display).toBe("none");
  });

  it("Accept, Join with video and Decline use the banner's callbacks", async () => {
    usePhone(true);
    banner.setRing(RING);
    await screenUp();

    q("incoming-call-screen-accept").click();
    expect(onAccept).toHaveBeenLastCalledWith(false);
    q("incoming-call-screen-accept-video").click();
    expect(onAccept).toHaveBeenLastCalledWith(true);
    q("incoming-call-screen-decline").click();
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it("Back hides the view down to the banner and declines nothing", async () => {
    usePhone(true);
    banner.setRing(RING);
    await screenUp();

    back.onBack[0]!();
    expect(screenEl()).toBeNull();
    expect(bannerEl().style.display).toBe("");
    expect(onDecline).not.toHaveBeenCalled();
    expect(onAccept).not.toHaveBeenCalled();

    // The ring goes on: a redial of it redraws the banner, not the full screen.
    banner.setRing(RING);
    await settle();
    expect(screenEl()).toBeNull();
    expect(bannerEl().style.display).toBe("");
  });

  it("a ring hidden with Back stays hidden after a trip through the DM call panel", async () => {
    usePhone(true);
    banner.setRing(RING);
    await screenUp();
    back.onBack[0]!();

    // The DM call panel takes the ring, then hands it back: the ring went on.
    banner.setRing(null, true);
    expect(bannerEl().style.display).toBe("none");
    banner.setRing(RING);
    await settle();
    expect(screenEl()).toBeNull();
    expect(bannerEl().style.display).toBe("");
  });

  it("Escape hides the view the same way", async () => {
    usePhone(true);
    banner.setRing(RING);
    await screenUp();

    screenEl()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(screenEl()).toBeNull();
    expect(bannerEl().style.display).toBe("");
  });

  it("the ring ending closes it, and gives Back up", async () => {
    usePhone(true);
    banner.setRing(RING);
    await screenUp();

    banner.setRing(null);
    expect(screenEl()).toBeNull();
    expect(bannerEl().style.display).toBe("none");
    expect(back.released).toBeGreaterThanOrEqual(1);
  });

  it("a new ring after a hidden one takes the screen again", async () => {
    usePhone(true);
    banner.setRing(RING);
    await screenUp();
    back.onBack[0]!();
    banner.setRing(null);

    banner.setRing(RING);
    await screenUp();
    expect(bannerEl().style.display).toBe("none");
  });

  it("a ring that ends while the view loads opens nothing", async () => {
    usePhone(true);
    banner.setRing(RING);
    banner.setRing(null);
    await settle();
    expect(screenEl()).toBeNull();
  });

  it("off a phone the banner stays the only surface", async () => {
    usePhone(false);
    banner.setRing(RING);
    await settle();
    expect(screenEl()).toBeNull();
    expect(bannerEl().style.display).toBe("");
    expect(back.onBack).toHaveLength(0);
  });

  it("turning to a wide window swaps the full screen for the banner", async () => {
    // The banner reads the layout when it starts, so it starts on the phone.
    banner.destroy?.();
    usePhone(true);
    banner = createIncomingCallBanner({ onAccept, onDecline });
    banner.mount(host);
    banner.setRing(RING);
    await screenUp();

    usePhone(false);
    window.dispatchEvent(new Event("resize"));
    expect(screenEl()).toBeNull();
    expect(bannerEl().style.display).toBe("");
  });
});
