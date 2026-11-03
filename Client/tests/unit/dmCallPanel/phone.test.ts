import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/dmCallPanelMocks";
import { channelsStore } from "../../../src/stores/channels.store";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { usePhone } from "../../helpers/phoneMedia";
import { SELF, OTTO, DM, vu, setVoice, mount, q, panel } from "../../helpers/dmCallPanelHarness";

vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("../../../src/features/voice/peerVerification", (importOriginal) =>
  mocks.voicePeerVerificationMock(importOriginal),
);

function activate(id: number): void {
  channelsStore.setState((prev) => ({ ...prev, activeChannelId: id }));
  channelsStore.flush();
}

async function back(): Promise<void> {
  // A claim made while an earlier Back is still on its way waits for it.
  await vi.waitFor(() => expect(history.state).not.toBeNull());
  const popped = new Promise((r) => window.addEventListener("popstate", r, { once: true }));
  history.back();
  await popped;
}

/** The previous test's panel gave its Back entry up; let that pop land first. */
async function settleHistory(): Promise<void> {
  if (history.state === null) return;
  await new Promise((r) => window.addEventListener("popstate", r, { once: true }));
}

describe("DmCallPanel on a phone", () => {
  beforeEach(async () => {
    await settleHistory();
    usePhone();
  });
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

  it("a call rung again after it went unanswered opens the call view again", () => {
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "ringing", pending: [OTTO] });
    q(root, "dcp-collapse")!.click();
    panel!.setOutgoing({ channelId: DM, phase: "no-answer", pending: [OTTO] });
    expect(root.dataset.state).toBe("unanswered");
    panel!.setOutgoing({ channelId: DM, phase: "ringing", pending: [OTTO] });
    expect(root.classList.contains("dm-call-panel--expanded")).toBe(true);
  });

  it("ringing that is answered keeps the collapsed bar", () => {
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "ringing", pending: [OTTO] });
    q(root, "dcp-collapse")!.click();
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    expect(root.dataset.state).toBe("connected");
    expect(root.classList.contains("dm-call-panel--collapsed")).toBe(true);
  });

  it("Back moves focus to Expand when the focused control leaves the bar", async () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    q(root, "dcp-camera")!.focus();
    // The call bar leaves Camera out on a phone; jsdom has no stylesheet.
    const focus = HTMLElement.prototype.focus;
    const spy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.testid !== "dcp-camera") focus.call(this);
    });
    await back();
    await vi.waitFor(() => expect(root.classList.contains("dm-call-panel--collapsed")).toBe(true));
    expect((document.activeElement as HTMLElement).dataset.testid).toBe("dcp-collapse");
    spy.mockRestore();
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
    const flat = css.replace(/\s+/g, " ");
    expect(flat).toContain(
      '.dm-call-panel--expanded:is([data-state="outgoing"], [data-state="connected"]) { flex: 1 1 auto; height: auto;',
    );
    // A ring or an unanswered call keeps the chat in view.
    expect(flat).toContain(
      '> .dm-call-panel--expanded:is([data-state="outgoing"], [data-state="connected"]):not( [hidden] ) ) > :is(.messages-slot, .typing-slot, .input-slot) { display: none;',
    );
  });
});
