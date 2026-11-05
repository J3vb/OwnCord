import { describe, it, expect, vi, afterEach } from "vitest";
import * as mocks from "../../helpers/dmCallPanelMocks";
import { panelVoiceKey } from "../../../src/features/direct-messages/DmCallPanel";
import { voiceStore } from "../../../src/stores/voice.store";
import {
  SELF,
  OTTO,
  DM,
  vu,
  setVoice,
  patchVoice,
  mount,
  q,
} from "../../helpers/dmCallPanelHarness";

vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("../../../src/features/voice/peerVerification", (importOriginal) =>
  mocks.voicePeerVerificationMock(importOriginal),
);

const SERVER_ROOM = 7;

afterEach(() => patchVoice({ encryptionDegraded: false, localGateSpeaking: null }));

/** The store's own element-wise compare, as subscribeSelector runs it. */
function sameKey(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

describe("DmCallPanel — the Secured chip", () => {
  it("is the voice widget's chip: shield icon and a plain word, no emoji", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    patchVoice({ voiceStatus: "connected" });
    const { root } = mount();
    const chip = q(root, "dcp-secured")!;
    expect(chip.classList.contains("vw-secured")).toBe(true);
    expect(chip.style.display).toBe("inline-flex");
    expect(chip.textContent).toBe("Secured");
    expect(chip.querySelector("svg")!.getAttribute("data-icon")).toBe("shield-check");
    expect(chip.title).toBe("End-to-end encrypted");
  });

  it("turns red and says Unsecured when encryption fails mid-call, drawing its icon once", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    patchVoice({ voiceStatus: "connected" });
    const { root } = mount();
    patchVoice({ encryptionDegraded: true });
    const chip = q(root, "dcp-secured")!;
    expect(chip.classList.contains("vw-secured--degraded")).toBe(true);
    expect(chip.textContent).toBe("Unsecured");
    const icon = chip.querySelector("svg")!;
    expect(icon.getAttribute("data-icon")).toBe("shield-alert");

    // Speaking ticks keep the same icon node.
    setVoice(DM, [vu(SELF), vu(OTTO, { speaking: true })]);
    expect(chip.querySelector("svg")).toBe(icon);
    expect(chip.querySelectorAll("svg")).toHaveLength(1);
  });

  it("hides while the call is not connected", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    patchVoice({ voiceStatus: "reconnecting" });
    const { root } = mount();
    expect(q(root, "dcp-secured")!.style.display).toBe("none");
  });
});

describe("DmCallPanel — which voice ticks redraw it", () => {
  it("skips the local mic gate and speaking in another room", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const before = panelVoiceKey(voiceStore.getState());

    patchVoice({ localGateSpeaking: true });
    const rooms = new Map(voiceStore.getState().voiceUsers);
    rooms.set(SERVER_ROOM, new Map([[9, vu(9, { speaking: true })]]));
    patchVoice({ voiceUsers: rooms });

    expect(sameKey(before, panelVoiceKey(voiceStore.getState()))).toBe(true);
  });

  it("follows speaking, mute and encryption changes in the call", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const before = panelVoiceKey(voiceStore.getState());

    setVoice(DM, [vu(SELF), vu(OTTO, { speaking: true })]);
    const speaking = panelVoiceKey(voiceStore.getState());
    expect(sameKey(before, speaking)).toBe(false);

    patchVoice({ localMuted: true });
    const muted = panelVoiceKey(voiceStore.getState());
    expect(sameKey(speaking, muted)).toBe(false);

    patchVoice({ encryptionDegraded: true });
    expect(sameKey(muted, panelVoiceKey(voiceStore.getState()))).toBe(false);
  });

  it("still draws the speaking ring after skipping an unrelated tick", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    patchVoice({ localGateSpeaking: true });
    setVoice(DM, [vu(SELF), vu(OTTO, { speaking: true })]);
    const otto = root.querySelector(`.dcp-avatar[data-user-id='${OTTO}']`)!;
    expect(otto.classList.contains("dcp-avatar--speaking")).toBe(true);
  });
});
