import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/dmCallPanelMocks";
import { channelsStore } from "../../../src/stores/channels.store";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { usePhone } from "../../helpers/phoneMedia";
import { SELF, OTTO, DM, vu, setVoice, mount, q } from "../../helpers/dmCallPanelHarness";

vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("../../../src/features/voice/peerVerification", (importOriginal) =>
  mocks.voicePeerVerificationMock(importOriginal),
);

function activate(id: number): void {
  channelsStore.setState((prev) => ({ ...prev, activeChannelId: id }));
  channelsStore.flush();
}

async function back(): Promise<void> {
  const popped = new Promise((r) => window.addEventListener("popstate", r, { once: true }));
  history.back();
  await popped;
}

describe("DmCallPanel on a phone", () => {
  beforeEach(() => usePhone());
  afterEach(() => vi.unstubAllGlobals());

  it("Back collapses the open call to the bar above the chat", async () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    expect(root.classList.contains("dm-call-panel--expanded")).toBe(true);

    await back();
    await vi.waitFor(() => expect(root.classList.contains("dm-call-panel--collapsed")).toBe(true));
    expect(q(root, "dcp-collapse")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("coming back to the call's DM opens the call view again", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    q(root, "dcp-collapse")!.click();
    expect(root.classList.contains("dm-call-panel--collapsed")).toBe(true);

    activate(7);
    expect(root.hidden).toBe(true);
    activate(DM);
    expect(root.classList.contains("dm-call-panel--expanded")).toBe(true);
  });

  it("stays collapsed while the call moves on in the same DM", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    q(root, "dcp-collapse")!.click();
    setVoice(DM, [vu(SELF), vu(OTTO, { speaking: true })]);
    expect(root.classList.contains("dm-call-panel--collapsed")).toBe(true);
  });
});

describe("DmCallPanel on a desktop", () => {
  it("keeps the collapsed choice when the DM is reopened", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    q(root, "dcp-collapse")!.click();
    activate(7);
    activate(DM);
    expect(root.classList.contains("dm-call-panel--collapsed")).toBe(true);
  });
});

describe("the phone call view stylesheet", () => {
  const css = readFileSync(join(process.cwd(), "src/styles/app/dm-call.css"), "utf8");

  it("lets the open call take the chat column and hides the chat behind it", () => {
    expect(css).toMatch(/\.dm-call-panel--expanded\s*\{\s*flex: 1 1 auto;\s*height: auto;/);
    expect(css).toContain(
      ".chat-area:has(> .call-panel-slot > .dm-call-panel--expanded:not([hidden]))",
    );
  });
});
