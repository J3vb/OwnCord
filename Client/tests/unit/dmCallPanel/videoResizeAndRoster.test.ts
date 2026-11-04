import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/dmCallPanelMocks";
import { voiceStore, setPeerVerification } from "../../../src/stores/voice.store";
import { openIdentityMismatchModal } from "../../../src/features/voice/peerVerification";
import { dmStore, type DmChannel } from "../../../src/stores/dm.store";
import { cascadedDeclaration } from "../../helpers/app-css";
import {
  SELF,
  OTTO,
  DM,
  dm,
  vu,
  CARA,
  DAN,
  member,
  ring,
  setVoice,
  patchVoice,
  MockedOptions,
  host,
  panel,
  mount,
  hostAvatars,
  q,
  shield,
  anyShield,
} from "../../helpers/dmCallPanelHarness";

vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("../../../src/features/voice/peerVerification", (importOriginal) =>
  mocks.voicePeerVerificationMock(importOriginal),
);

/** A blocked peer's shield on their avatar, then their camera tile arriving in the grid. */
async function mountBlockedPeerOnCameraTile(options: { attach?: boolean } = {}) {
  setVoice(DM, [vu(SELF), vu(OTTO)]);
  const { opts, root } = mount();
  if (options.attach) document.body.appendChild(root);
  panel!.setVideoActive(true);
  setPeerVerification({
    userId: OTTO,
    status: "mismatch",
    safetyNumber: null,
    sessionFingerprint: null,
  });
  voiceStore.flush();
  hostAvatars(opts);
  const cell = document.createElement("div");
  cell.className = "video-cell";
  cell.dataset.userId = String(OTTO);
  cell.dataset.streamType = "camera";
  panel!.videoElement()!.appendChild(cell);
  await Promise.resolve();
  return { opts, root, cell };
}

describe("DmCallPanel — video in the call", () => {
  type Person = { userId: number; label: string; content: HTMLElement };
  const lastPeople = (opts: MockedOptions): Person[] =>
    (opts.videoGrid.setPeople.mock.calls.at(-1)?.[0] as Person[] | undefined) ?? [];

  it("owns the call it is showing, and only that one", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    mount();
    expect(panel!.ownsCall(DM)).toBe(true);
    expect(panel!.ownsCall(7)).toBe(false);
  });

  it("does not own a call you are not in", () => {
    setVoice(null, [vu(OTTO)]);
    mount();
    expect(panel!.ownsCall(DM)).toBe(false);
    expect(panel!.videoElement()).toBeNull();
  });

  it("makes room for the grid in its stage while video is on, with the chat left alone", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    const el = panel!.videoElement()!;
    expect(el).not.toBeNull();
    expect(root.contains(el)).toBe(false);

    panel!.setVideoActive(true);

    expect(root.contains(el)).toBe(true);
    expect(root.classList.contains("dm-call-panel--video")).toBe(true);
    expect(root.querySelector(".dcp-stage")).toBeNull();
    // The call controls stay under the video.
    expect(q(root, "dcp-mute")).not.toBeNull();
  });

  it("hands the grid an avatar tile for everyone in the call, kept live in place", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts } = mount();
    panel!.setVideoActive(true);

    const people = lastPeople(opts);
    expect(people.map((p) => [p.userId, p.label])).toEqual([
      [SELF, "You"],
      [OTTO, "Otto"],
    ]);
    const otto = people[1]!.content;
    expect(otto.classList.contains("dcp-avatar")).toBe(true);

    setVoice(DM, [vu(SELF), vu(OTTO, { speaking: true })]);
    expect(otto.classList.contains("dcp-avatar--speaking")).toBe(true);
  });

  it("keeps keyboard focus on a control inside the video when someone joins", () => {
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    panel!.setVideoActive(true);
    const slider = document.createElement("input");
    slider.type = "range";
    panel!.videoElement()!.appendChild(slider);
    slider.focus();

    setVoice(DM, [vu(SELF), vu(OTTO)]);

    expect(root.contains(slider)).toBe(true);
    expect(document.activeElement).toBe(slider);
  });

  it("never moves the video when someone joins or leaves, so a full-screen tile stays", () => {
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    panel!.setVideoActive(true);
    const el = panel!.videoElement()!;
    const observer = new MutationObserver(() => {});
    observer.observe(root, { childList: true, subtree: true });

    setVoice(DM, [vu(SELF), vu(OTTO)]);
    setVoice(DM, [vu(SELF)]);

    const removed = observer.takeRecords().flatMap((r) => [...r.removedNodes]);
    observer.disconnect();
    expect(removed).not.toContain(el);
    expect(root.contains(el)).toBe(true);
    // The call controls stay under the video.
    expect(
      el.compareDocumentPosition(q(root, "dcp-mute")!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("gives the grid nobody once video goes off", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    panel!.setVideoActive(true);
    panel!.setVideoActive(false);

    expect(lastPeople(opts)).toEqual([]);
    expect(root.querySelector(".dcp-stage")).not.toBeNull();
  });

  it("collapsed, it shows no video and never expands on its own; Expand shows it", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    q(root, "dcp-collapse")!.click();
    opts.onVideoHostChange.mockClear();

    panel!.setVideoActive(true);
    expect(panel!.videoElement()).toBeNull();
    expect(root.classList.contains("dm-call-panel--collapsed")).toBe(true);
    expect(q(root, "dcp-watch")).toBeNull();

    q(root, "dcp-collapse")!.click();

    expect(root.classList.contains("dm-call-panel--expanded")).toBe(true);
    expect(root.contains(panel!.videoElement())).toBe(true);
    expect(opts.onVideoHostChange).toHaveBeenCalled();
  });

  it("shows your own video while the call is still ringing, with the ring caption kept", () => {
    setVoice(DM, [vu(SELF)]);
    const { opts, root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "ringing", pending: [OTTO] });
    const el = panel!.videoElement()!;
    expect(el).not.toBeNull();

    panel!.setVideoActive(true);

    expect(root.contains(el)).toBe(true);
    expect(root.classList.contains("dm-call-panel--video")).toBe(true);
    expect(q(root, "dcp-caption")!.textContent).toBe("Calling Otto…");
    expect(q(root, "dcp-camera")).not.toBeNull();
    const people = lastPeople(opts);
    expect(people.map((p) => p.userId)).toEqual([SELF, OTTO]);
    expect(people[0]!.content.classList.contains("dcp-avatar--ringing")).toBe(false);
    expect(people[1]!.content.classList.contains("dcp-avatar--ringing")).toBe(true);
  });

  it("shows your own safety number on your own shield while you are in the call", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    panel!.setVideoActive(true);
    hostAvatars(opts);
    expect(shield(root, SELF)).toBeNull();

    patchVoice({ localSafetyNumber: "AB12 CD34", localSessionFingerprint: "5E55 1234" });
    const own = shield(root, SELF)!;
    expect(own).not.toBeNull();
    expect(own.tagName).toBe("SPAN");
    expect(own.title).toContain("Your safety number: AB12 CD34");
    expect(own.title).toContain("5E55 1234");
    expect(own.getAttribute("aria-label")).toBe(own.title);

    // A new session's numbers redraw it; leaving the session removes it.
    patchVoice({ localSafetyNumber: "FFFF 0000" });
    expect(shield(root, SELF)!.title).toContain("FFFF 0000");
    patchVoice({ localSafetyNumber: null, localSessionFingerprint: null });
    expect(shield(root, SELF)).toBeNull();
  });

  it("shows no own shield when the numbers belong to another call", () => {
    const elsewhere = 555;
    setVoice(elsewhere, [vu(SELF)], elsewhere);
    patchVoice({ localSafetyNumber: "AB12 CD34", localSessionFingerprint: "5E55 1234" });
    const { root } = mount();
    panel!.setIncoming(ring);
    patchVoice({ localSafetyNumber: "AB12 CD35" });
    expect(shield(root, SELF)).toBeNull();
  });

  it("moves a blocked peer's shield with their camera tile, and back when it goes", async () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    panel!.setVideoActive(true);
    setPeerVerification({
      userId: OTTO,
      status: "mismatch",
      safetyNumber: null,
      sessionFingerprint: null,
    });
    voiceStore.flush();
    hostAvatars(opts);
    const onAvatar = shield(root, OTTO)!;
    expect(onAvatar).not.toBeNull();

    const cell = document.createElement("div");
    cell.className = "video-cell";
    cell.dataset.userId = String(OTTO);
    cell.dataset.streamType = "camera";
    panel!.videoElement()!.appendChild(cell);
    await Promise.resolve();

    const badge = cell.querySelector<HTMLElement>(".dcp-verify")!;
    expect(badge).toBe(onAvatar);
    expect(badge.tagName).toBe("BUTTON");
    badge.click();
    expect(openIdentityMismatchModal).toHaveBeenCalledWith(
      OTTO,
      "Otto",
      expect.any(AbortSignal),
      expect.any(Function),
    );

    cell.remove();
    await Promise.resolve();
    expect(shield(root, OTTO)).toBe(badge);
  });

  it("keeps focus on a focused shield when its camera tile is swapped away", async () => {
    const { root, cell } = await mountBlockedPeerOnCameraTile({ attach: true });

    const badge = anyShield(root)!;
    badge.focus();
    expect(document.activeElement).toBe(badge);
    cell.remove();
    await Promise.resolve();

    expect(document.activeElement).toBe(anyShield(root));
    root.remove();
  });

  it("does not steal focus back after the shield was blurred and the grid mutates", async () => {
    const { root, cell } = await mountBlockedPeerOnCameraTile({ attach: true });

    anyShield(root)!.focus();
    anyShield(root)!.blur();
    cell.appendChild(document.createElement("span"));
    await Promise.resolve();

    expect(document.activeElement).toBe(document.body);
    root.remove();
  });

  it("refocuses the shield when blur fires before its tile is detached", async () => {
    const { root, cell } = await mountBlockedPeerOnCameraTile({ attach: true });

    const badge = anyShield(root)!;
    badge.focus();
    badge.dispatchEvent(new FocusEvent("blur"));
    cell.remove();
    await Promise.resolve();
    expect(document.activeElement).toBe(anyShield(root));

    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).toBe(anyShield(root));
    root.remove();
  });

  it("does not refocus a shield the panel itself replaced on rebuild", async () => {
    const { root, cell } = await mountBlockedPeerOnCameraTile({ attach: true });

    anyShield(root)!.focus();
    q(root, "dcp-collapse")!.click();
    q(root, "dcp-collapse")?.click();
    voiceStore.flush();
    await Promise.resolve();
    (document.activeElement as HTMLElement | null)?.blur();
    cell.remove();
    await Promise.resolve();

    expect(document.activeElement).toBe(document.body);
    root.remove();
  });

  it("leaves one shield on a camera tile across a panel rebuild", async () => {
    const { root, cell } = await mountBlockedPeerOnCameraTile();

    q(root, "dcp-collapse")!.click();
    q(root, "dcp-collapse")?.click();
    voiceStore.flush();
    await Promise.resolve();

    expect(cell.querySelectorAll(".dcp-verify")).toHaveLength(1);
  });

  it("keeps your own video once the call went unanswered, without the absent callee's tile", () => {
    setVoice(DM, [vu(SELF)]);
    const { opts, root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "declined", pending: [] });
    panel!.setVideoActive(true);

    const people = lastPeople(opts);
    expect(people.map((p) => p.userId)).toEqual([SELF]);

    expect(root.contains(panel!.videoElement())).toBe(true);
    expect(q(root, "dcp-caption")!.textContent).toBe("Otto declined the call");
    expect(q(root, "dcp-ring-again")).not.toBeNull();
  });

  it("tells its owner when it can or cannot host video any more", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    opts.onVideoHostChange.mockClear();

    q(root, "dcp-collapse")!.click();
    expect(opts.onVideoHostChange).toHaveBeenCalledTimes(1);

    setVoice(null, []);
    expect(opts.onVideoHostChange).toHaveBeenCalledTimes(2);
  });
});

describe("DmCallPanel — resize", () => {
  const PREF = "owncord:settings:dmCallHeight";
  const box = (height: number) => ({ height }) as DOMRect;

  /** jsdom lays nothing out: a 1000px chat column, and a panel drawn at its
   *  dragged height (400px by default), never below `contentMin`. */
  function sized(root: HTMLElement, contentMin = 0): void {
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue(box(1000));
    vi.spyOn(root, "getBoundingClientRect").mockImplementation(() => {
      const dragged = parseFloat(root.style.getPropertyValue("--dcp-height"));
      return box(Math.max(contentMin, Number.isNaN(dragged) ? 400 : dragged));
    });
  }

  const pointer = (type: string, clientY: number) =>
    new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientY });

  beforeEach(() => localStorage.removeItem(PREF));
  afterEach(() => localStorage.removeItem(PREF));

  it("drags the bottom edge, keeps room for the chat, and remembers the height", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    sized(root);
    const handle = q(root, "dcp-resize")!;
    expect(handle.hidden).toBe(false);
    expect(handle.getAttribute("role")).toBe("separator");
    expect(root.style.getPropertyValue("--dcp-height")).toBe("");

    handle.dispatchEvent(pointer("pointerdown", 400));
    handle.dispatchEvent(pointer("pointermove", 520));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("520px");
    // 1000px column less 120px kept for the messages.
    handle.dispatchEvent(pointer("pointermove", 2000));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("880px");
    expect(handle.getAttribute("aria-valuemax")).toBe("880");
    handle.dispatchEvent(pointer("pointermove", -500));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("160px");
    expect(localStorage.getItem(PREF)).toBeNull();
    handle.dispatchEvent(pointer("pointermove", 450));
    handle.dispatchEvent(pointer("pointerup", 450));
    expect(localStorage.getItem(PREF)).toBe("450");

    // A move without a press does nothing.
    handle.dispatchEvent(pointer("pointermove", 700));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("450px");

    panel!.destroy?.();
    const { root: again } = mount();
    expect(again.style.getPropertyValue("--dcp-height")).toBe("450px");
  });

  it("hides the handle and drops the height while collapsed", () => {
    localStorage.setItem(PREF, "300");
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    expect(root.style.getPropertyValue("--dcp-height")).toBe("300px");

    q(root, "dcp-collapse")!.click();
    expect(q(root, "dcp-resize")!.hidden).toBe(true);
    expect(root.style.getPropertyValue("--dcp-height")).toBe("");

    q(root, "dcp-collapse")!.click();
    expect(q(root, "dcp-resize")!.hidden).toBe(false);
    expect(root.style.getPropertyValue("--dcp-height")).toBe("300px");
  });

  it("resizes from the keyboard and double-click restores the default", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    sized(root);
    const handle = q(root, "dcp-resize")!;

    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("424px");
    expect(handle.getAttribute("aria-valuenow")).toBe("424");
    expect(localStorage.getItem(PREF)).toBe("424");
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("400px");

    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("");
    expect(localStorage.getItem(PREF)).toBe("0");
  });

  it("keeps the header and composer out of the room a drag can take", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    sized(root);
    const composer = document.createElement("div");
    host.appendChild(composer);
    vi.spyOn(composer, "getBoundingClientRect").mockReturnValue(box(200));
    const handle = q(root, "dcp-resize")!;

    handle.dispatchEvent(pointer("pointerdown", 400));
    handle.dispatchEvent(pointer("pointermove", 2000));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("680px");
  });

  it("reports the drawn height on first show", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const original = HTMLElement.prototype.getBoundingClientRect;
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.dataset.testid === "dm-call-panel" && !this.hidden) return box(464);
        return original.call(this);
      });
    try {
      const { root } = mount();
      expect(q(root, "dcp-resize")!.getAttribute("aria-valuenow")).toBe("464");
    } finally {
      spy.mockRestore();
    }
  });

  it("never saves a height under what an audio-only panel draws", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    sized(root, 260);
    const handle = q(root, "dcp-resize")!;

    handle.dispatchEvent(pointer("pointerdown", 400));
    handle.dispatchEvent(pointer("pointermove", 100));
    handle.dispatchEvent(pointer("pointerup", 100));
    expect(root.style.getPropertyValue("--dcp-height")).toBe("260px");
    expect(handle.getAttribute("aria-valuenow")).toBe("260");
    expect(localStorage.getItem(PREF)).toBe("260");
  });

  it("ends a drag when the call collapses under it", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    sized(root);
    const handle = q(root, "dcp-resize")!;

    handle.dispatchEvent(pointer("pointerdown", 400));
    handle.dispatchEvent(pointer("pointermove", 500));
    q(root, "dcp-collapse")!.click();
    expect(localStorage.getItem(PREF)).toBe("500");
    handle.dispatchEvent(pointer("pointermove", 700));
    q(root, "dcp-collapse")!.click();
    expect(root.style.getPropertyValue("--dcp-height")).toBe("500px");
  });

  it("clamps the dragged height to the chat column in the stylesheet", () => {
    const height = cascadedDeclaration(".dm-call-panel--expanded", "height");
    expect(JSON.stringify(height)).toContain("dcp-height");
  });
});

describe("DmCallPanel — group roster (3B-8)", () => {
  const group = (): DmChannel =>
    dm({
      isGroup: true,
      name: "Trio",
      participants: [member(OTTO, "otto"), member(CARA, "cara"), member(DAN, "dan")],
    });
  const tile = (root: HTMLElement, id: number) =>
    root.querySelector<HTMLElement>(`.dcp-avatar[data-user-id='${id}']`)!;
  const ids = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>(".dcp-person .dcp-avatar")].map((e) =>
      Number(e.dataset.userId),
    );
  const greyed = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLElement>(".dcp-avatar--absent")].map((e) =>
      Number(e.dataset.userId),
    );

  beforeEach(() => {
    dmStore.setState(() => ({ channels: [group()] }));
    dmStore.flush();
  });

  it("shows in-call members, then ringing, then the rest greyed out and labelled", () => {
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "ringing", pending: [CARA] });

    expect(root.dataset.state).toBe("outgoing");
    expect(ids(root)).toEqual([SELF, CARA, OTTO, DAN]);
    expect(tile(root, CARA).classList.contains("dcp-avatar--ringing")).toBe(true);
    expect(greyed(root)).toEqual([OTTO, DAN]);
    expect(tile(root, SELF).classList.contains("dcp-avatar--absent")).toBe(false);
    expect(root.querySelectorAll(".dcp-person--absent")).toHaveLength(2);
    expect(tile(root, OTTO).title).toBe("Not in call");
    expect(tile(root, OTTO).querySelector(".sr-only")!.textContent).toBe("Not in call");
  });

  it("greys out every other member once the ring went unanswered", () => {
    setVoice(DM, [vu(SELF)]);
    const { root } = mount();
    panel!.setOutgoing({ channelId: DM, phase: "no-answer", pending: [OTTO, CARA, DAN] });

    expect(root.dataset.state).toBe("unanswered");
    expect(greyed(root)).toEqual([OTTO, CARA, DAN]);
  });

  it("moves a member from greyed to in-call when they join, and back when they leave", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    expect(ids(root)).toEqual([SELF, OTTO, CARA, DAN]);
    expect(greyed(root)).toEqual([CARA, DAN]);

    setVoice(DM, [vu(SELF), vu(OTTO), vu(CARA)]);
    expect(ids(root)).toEqual([SELF, OTTO, CARA, DAN]);
    expect(greyed(root)).toEqual([DAN]);

    setVoice(DM, [vu(SELF), vu(CARA)]);
    expect(ids(root)).toEqual([SELF, CARA, OTTO, DAN]);
    expect(greyed(root)).toEqual([OTTO, DAN]);
  });

  it("follows the group's participant list", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    expect(greyed(root)).toEqual([CARA, DAN]);

    dmStore.setState(() => ({
      channels: [{ ...group(), participants: [member(OTTO, "otto"), member(CARA, "cara")] }],
    }));
    dmStore.flush();
    expect(greyed(root)).toEqual([CARA]);

    dmStore.setState(() => ({
      channels: [
        {
          ...group(),
          participants: [member(OTTO, "otto"), member(CARA, "cara"), member(5, "eve")],
        },
      ],
    }));
    dmStore.flush();
    expect(greyed(root)).toEqual([CARA, 5]);
  });

  it("greys the absent members in the live strip too", () => {
    setVoice(null, [vu(OTTO)]);
    const { root } = mount();
    expect(root.dataset.state).toBe("live");
    const faces = [...root.querySelectorAll<HTMLElement>(".dcp-faces .dcp-avatar")];
    expect(faces.map((e) => Number(e.dataset.userId))).toEqual([OTTO, CARA, DAN]);
    expect(greyed(root)).toEqual([CARA, DAN]);
    for (const id of [CARA, DAN]) {
      expect(tile(root, id).title).toBe("Not in call");
      expect(tile(root, id).querySelector(".sr-only")!.textContent).toBe("Not in call");
    }
    expect(tile(root, OTTO).title).toBe("");
  });

  it("offers Ring again after a peer leaves, while someone is missing, and re-rings", () => {
    setVoice(DM, [vu(SELF), vu(OTTO), vu(CARA), vu(DAN)]);
    const { opts, root } = mount();
    expect(q(root, "dcp-ring-again")).toBeNull();

    setVoice(DM, [vu(SELF), vu(OTTO), vu(CARA)]);
    expect(root.dataset.state).toBe("connected");
    expect(q(root, "dcp-ring-again")!.textContent).toBe("Ring again");
    q(root, "dcp-ring-again")!.click();
    expect(opts.onRingAgain).toHaveBeenCalledWith(DM);

    setVoice(DM, [vu(SELF), vu(OTTO), vu(CARA), vu(DAN)]);
    expect(q(root, "dcp-ring-again")).toBeNull();
  });

  it("draws the greyed members as avatar tiles in the video grid", () => {
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { opts, root } = mount();
    panel!.setVideoActive(true);
    hostAvatars(opts);

    expect(
      [...root.querySelectorAll<HTMLElement>(".dcp-avatar--absent")].map((e) =>
        Number(e.dataset.userId),
      ),
    ).toEqual([CARA, DAN]);
    for (const id of [CARA, DAN]) {
      expect(tile(root, id).title).toBe("Not in call");
      expect(tile(root, id).querySelector(".sr-only")!.textContent).toBe("Not in call");
    }
  });

  it("leaves a 1:1 call without a roster or Ring again", () => {
    dmStore.setState(() => ({ channels: [dm()] }));
    dmStore.flush();
    setVoice(DM, [vu(SELF), vu(OTTO)]);
    const { root } = mount();
    expect(ids(root)).toEqual([SELF, OTTO]);
    expect(greyed(root)).toEqual([]);
    expect(q(root, "dcp-ring-again")).toBeNull();
  });
});
