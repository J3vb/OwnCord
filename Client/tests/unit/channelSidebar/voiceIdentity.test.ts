import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as mocks from "../../helpers/channelSidebarMocks";
import { createChannelSidebar } from "../../../src/components/ChannelSidebar";
import { channelsStore, setChannels } from "../../../src/stores/channels.store";
import { authStore } from "../../../src/stores/auth.store";
import { voiceStore } from "../../../src/stores/voice.store";
import { membersStore } from "../../../src/stores/members.store";
import { computeKeyFingerprint } from "@lib/net/e2eeCrypto";
import { expectConsole } from "../../helpers/console";
import {
  resetStores,
  addVoiceUser,
  setPeerVerif,
  testChannels,
} from "../../helpers/channelSidebarHarness";

vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/net/e2eeCrypto", (importOriginal) => mocks.netE2eeCryptoMock(importOriginal));
vi.mock("../../../src/features/messaging/content/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);
vi.mock("../../../src/features/profiles/openUserProfilePopup", () =>
  mocks.profilesOpenUserProfilePopupMock(),
);

const { mockRePinPeerIdentity, mockShowToast } = mocks;

/** Give peer 10 a published identity key. */
function publishAliceKey(): void {
  membersStore.setState((prev) => {
    const members = new Map(prev.members);
    members.set(10, {
      id: 10,
      username: "Alice",
      avatar: null,
      role: "member",
      status: "online",
      identityPublicKey: "alice-published-key-b64",
    });
    return { ...prev, members };
  });
}

const waitForModal = (): Promise<void> =>
  vi.waitFor(() => {
    expect(document.body.querySelector(".modal-overlay")).not.toBeNull();
  });

const waitForTrustButton = (): Promise<HTMLButtonElement> =>
  vi.waitFor(() => {
    const btn = document.body.querySelector(".modal-overlay .btn-danger") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    return btn;
  });

// ── E2EE identity verification badge on voice user rows (F3 TOFU) ──

describe("ChannelSidebar voice identity badge", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;

  const VOICE_CH = 3; // "voice-lobby" in testChannels

  beforeEach(() => {
    resetStores();
    setChannels(testChannels);
    container = document.createElement("div");
    document.body.appendChild(container);
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());
    mockRePinPeerIdentity.mockClear();
  });

  function badgeFor(userId: number): HTMLElement | null {
    return container.querySelector(`.voice-user-item[data-voice-uid="${userId}"] .vu-verify`);
  }

  it("shows a verified badge carrying the safety number in its title", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "verified", "AB12 CD34 EF56 7890");
    sidebar.mount(container);

    const badge = badgeFor(10);
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains("verified")).toBe(true);
    expect(badge!.getAttribute("title")).toContain("AB12 CD34 EF56 7890");
  });

  it("shows an unverified badge for a legacy peer", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "unverified", null);
    sidebar.mount(container);

    const badge = badgeFor(10);
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains("unverified")).toBe(true);
  });

  it("shows the session fingerprint, labelled as not an identity, on an unverified badge", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "unverified", null, "5E55 1234 5678 9ABC");
    sidebar.mount(container);

    const title = badgeFor(10)!.getAttribute("title") ?? "";
    expect(title).toContain("5E55 1234 5678 9ABC");
    expect(title).toContain("not an identity");
  });

  it("refreshes the badge tooltip when a peer's session fingerprint changes at an unchanged status", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "unverified", null, "5E55 1234 5678 9ABC");
    sidebar.mount(container);

    expect(badgeFor(10)!.getAttribute("title") ?? "").toContain("5E55 1234 5678 9ABC");

    // Peer reconnects: LiveKit E2EE re-announces a fresh ephemeral keypair,
    // producing a new session fingerprint while `status` stays "unverified".
    setPeerVerif(10, "unverified", null, "9C71 8888 4444 2222");
    voiceStore.flush();

    const title = badgeFor(10)!.getAttribute("title") ?? "";
    expect(title).toContain("9C71 8888 4444 2222");
    expect(title).not.toContain("5E55 1234 5678 9ABC");
  });

  it("shows the local user's own session fingerprint on their voice row", () => {
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 7, username: "Me", avatar: null, role: "member", status: "online" } as never,
      isAuthenticated: true,
    }));
    addVoiceUser(VOICE_CH, 7, "Me");
    voiceStore.setState((prev) => ({ ...prev, localSessionFingerprint: "0123 4567 89AB CDEF" }));
    sidebar.mount(container);

    const own = container.querySelector(`.voice-user-item[data-voice-uid="7"] .vu-session-fp`);
    expect(own).not.toBeNull();
    expect(own!.getAttribute("title")).toContain("0123 4567 89AB CDEF");
  });

  it("shows a new-device badge, not a plain verified one, after a new device key was accepted", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "changed", "AB12 CD34");
    sidebar.mount(container);

    const badge = badgeFor(10);
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains("changed")).toBe(true);
    expect(badge!.getAttribute("title")).toContain("New device");
    expect(badge!.getAttribute("title")).toContain("AB12 CD34");
    expect(badge!.getAttribute("title")).not.toContain("Same key as before");
  });

  it("shows a mismatch badge for a blocked peer", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "mismatch", null);
    sidebar.mount(container);

    const badge = badgeFor(10);
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains("mismatch")).toBe(true);
  });

  it("shows a distinct 'could not check' badge when the pin store was unreadable", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "unknown", null);
    sidebar.mount(container);

    const badge = badgeFor(10);
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains("unknown")).toBe(true);
    // Must not read as the legacy "no key published" state — the message is
    // about local storage failing, not about the peer.
    expect(badge!.classList.contains("unverified")).toBe(false);
    expect(badge!.getAttribute("title")).toContain("Could not check");
  });

  it("shows no badge when the peer's verification is unresolved", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    sidebar.mount(container);

    expect(badgeFor(10)).toBeNull();
  });

  it("re-renders the badge when a peer's verification changes after mount", () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "unverified", null);
    sidebar.mount(container);
    expect(badgeFor(10)!.classList.contains("unverified")).toBe(true);

    setPeerVerif(10, "verified", "AB12 CD34");
    voiceStore.flush();

    const badge = badgeFor(10);
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains("verified")).toBe(true);
  });

  it("opens the identity-mismatch modal when the mismatch badge is clicked", async () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "mismatch", null);
    sidebar.mount(container);

    // Opening is async (computes the changed key's fingerprint before mounting).
    (badgeFor(10) as HTMLElement).click();
    await waitForModal();
  });

  it("shows the changed key's fingerprint in the mismatch modal for out-of-band verification", async () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    // The peer must have a published identity key for its fingerprint to be shown.
    publishAliceKey();
    setPeerVerif(10, "mismatch", null);
    sidebar.mount(container);

    (badgeFor(10) as HTMLElement).click();
    await vi.waitFor(() => {
      const fp = document.body.querySelector(".modal-overlay .cert-fingerprint");
      expect(fp?.textContent).toBe("FEED FACE 1234 5678");
    });
  });

  it("re-pins the displayed key when the mismatch modal's Trust button is clicked", async () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    // The peer must have a published key so its fingerprint is shown and there
    // is a concrete verified key to re-pin.
    publishAliceKey();
    setPeerVerif(10, "mismatch", null);
    sidebar.mount(container);

    (badgeFor(10) as HTMLElement).click();
    const trustBtn = await waitForTrustButton();
    trustBtn.click();

    // Pins the exact key whose fingerprint was displayed, not a bare userId.
    expect(mockRePinPeerIdentity).toHaveBeenCalledWith(10, "alice-published-key-b64");
    // The modal closes once the re-pin confirms (#22: it no longer closes
    // before the write is known to have succeeded).
    await vi.waitFor(() => {
      expect(document.body.querySelector(".modal-overlay")).toBeNull();
    });
  });

  // The user verifies the DISPLAYED fingerprint out of band, which takes human
  // time. A malicious server can push a user_update during that window; if
  // Trust re-read membersStore instead of using the captured key, the swapped
  // key would get pinned (TOCTOU).
  it("pins the displayed key, not one the server swapped in during the verification window", async () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    publishAliceKey();
    setPeerVerif(10, "mismatch", null);
    sidebar.mount(container);

    (badgeFor(10) as HTMLElement).click();
    const trustBtn = await waitForTrustButton();

    // Server mutates the peer's key while the modal is open and the human is
    // still comparing the fingerprint it displayed.
    membersStore.setState((prev) => {
      const members = new Map(prev.members);
      members.set(10, { ...members.get(10)!, identityPublicKey: "attacker-swapped-key-b64" });
      return { ...prev, members };
    });

    trustBtn.click();

    expect(mockRePinPeerIdentity).toHaveBeenCalledWith(10, "alice-published-key-b64");
    expect(mockRePinPeerIdentity).not.toHaveBeenCalledWith(10, "attacker-swapped-key-b64");
  });

  it("does not re-pin when the fingerprint could not be computed (no blind accept)", async () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    publishAliceKey();
    setPeerVerif(10, "mismatch", null);
    // The changed key's fingerprint cannot be computed → the modal shows no
    // fingerprint, so Trust must not pin a key the user never got to verify.
    (computeKeyFingerprint as any).mockRejectedValueOnce(new Error("bad key"));
    sidebar.mount(container);

    (badgeFor(10) as HTMLElement).click();
    const trustBtn = await waitForTrustButton();
    expectConsole("warn", /\[peer-verification\] E2EE: could not compute changed-key fingerprint/);
    trustBtn.click();

    expect(mockRePinPeerIdentity).not.toHaveBeenCalled();
    expect(document.body.querySelector(".modal-overlay")).toBeNull();
  });

  it("surfaces a failed re-pin instead of silently staying blocked (#22)", async () => {
    // rePinPeerIdentity returns false (rather than rejecting) when it could
    // not persist the new pin; the caller used to ignore that boolean, so
    // "Trust New Key" closed the modal and the peer stayed blocked silently.
    addVoiceUser(VOICE_CH, 10, "Alice");
    publishAliceKey();
    setPeerVerif(10, "mismatch", null);
    mockRePinPeerIdentity.mockResolvedValueOnce(false);
    sidebar.mount(container);

    (badgeFor(10) as HTMLElement).click();
    const trustBtn = await waitForTrustButton();
    trustBtn.click();

    await vi.waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(expect.stringContaining("Couldn't"), "error");
    });
  });

  it("closes an open mismatch modal on sidebar destroy", async () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "mismatch", null);
    sidebar.mount(container);

    (badgeFor(10) as HTMLElement).click();
    await waitForModal();

    sidebar.destroy?.();
    expect(document.body.querySelector(".modal-overlay")).toBeNull();
  });
});

// ── Identity-mismatch modal must not be bound to the per-render signal (OC-0281) ──
//
// openIdentityMismatchModal used to receive renderChannels()'s render-scoped
// AbortSignal (aborted and replaced on EVERY re-render), not the sidebar's own
// lifetime signal. That means any unrelated re-render -- a message landing in
// another channel, a voice peer toggling mute, the WS flipping to
// reconnecting -- tears the open re-pin prompt down, and a re-render landing
// during the async fingerprint compute makes the click a silent no-op.
describe("ChannelSidebar identity-mismatch modal lifetime", () => {
  let container: HTMLDivElement;
  let sidebar: ReturnType<typeof createChannelSidebar>;

  const VOICE_CH = 3; // "voice-lobby" in testChannels

  beforeEach(() => {
    resetStores();
    setChannels(testChannels);
    container = document.createElement("div");
    document.body.appendChild(container);
    sidebar = createChannelSidebar({ onVoiceJoin: vi.fn(), onOpenCall: vi.fn() });
  });

  afterEach(() => {
    sidebar.destroy?.();
    container.remove();
    document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());
  });

  function badgeFor(userId: number): HTMLElement | null {
    return container.querySelector(`.voice-user-item[data-voice-uid="${userId}"] .vu-verify`);
  }

  it("keeps the mismatch modal open across a sidebar re-render unrelated to the modal", async () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    setPeerVerif(10, "mismatch", null);
    sidebar.mount(container);

    (badgeFor(10) as HTMLElement).click();
    await waitForModal();

    // Unrelated re-render, the same shape as a message landing in another
    // channel (dispatcher -> incrementUnread -> new channels Map ->
    // renderChannels()). Nothing about the open modal should care.
    setChannels(testChannels);
    channelsStore.flush();

    expect(document.body.querySelector(".modal-overlay")).not.toBeNull();
  });

  it("still opens the mismatch modal when an unrelated re-render lands during the fingerprint compute", async () => {
    addVoiceUser(VOICE_CH, 10, "Alice");
    publishAliceKey();
    setPeerVerif(10, "mismatch", null);
    sidebar.mount(container);

    // Hold the fingerprint compute open so a re-render can land mid-flight.
    let resolveFingerprint: (v: string) => void = () => {};
    (computeKeyFingerprint as any).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFingerprint = resolve;
        }),
    );

    (badgeFor(10) as HTMLElement).click();

    // Let the click's async handler actually reach the (held-open) fingerprint
    // compute before landing the re-render, so the re-render provably lands
    // mid-flight rather than before the compute even started.
    await vi.waitFor(() => {
      expect(computeKeyFingerprint).toHaveBeenCalled();
    });

    // Unrelated re-render lands while the click's async fingerprint compute
    // is still in flight.
    setChannels(testChannels);
    channelsStore.flush();

    resolveFingerprint("FEED FACE 1234 5678");

    await waitForModal();
  });
});
