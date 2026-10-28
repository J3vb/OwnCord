/**
 * Peer identity verification as the call surfaces show it: the shield's look
 * for each verification status, the tooltip for your own shield, and the
 * re-pin prompt a blocked peer's shield opens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLogs } from "../../../tests/helpers/log-capture";
import { expectConsole } from "../../../tests/helpers/console";
import type { PeerVerification } from "../../stores/voice.store";

const rePinPeerIdentity = vi.hoisted(() => vi.fn());
const peerAnnouncedIdentityKey = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());
const importIdentityPublicKey = vi.hoisted(() => vi.fn());
const computeKeyFingerprint = vi.hoisted(() => vi.fn());

vi.mock("../../lib/livekitSession", () => ({ rePinPeerIdentity, peerAnnouncedIdentityKey }));
vi.mock("../../lib/toast", () => ({ showToast }));
vi.mock("../../lib/e2eeCrypto", () => ({ importIdentityPublicKey, computeKeyFingerprint }));
// Lets a test act at the instant an open prompt is torn down.
const hooks = vi.hoisted(() => ({ onDestroy: null as (() => void) | null }));
vi.mock("../../components/IdentityMismatchModal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/IdentityMismatchModal")>();
  return {
    ...actual,
    createIdentityMismatchModal: (
      options: Parameters<typeof actual.createIdentityMismatchModal>[0],
    ) => {
      const modal = actual.createIdentityMismatchModal(options);
      const destroy = modal.destroy?.bind(modal);
      return {
        ...modal,
        destroy: () => {
          hooks.onDestroy?.();
          destroy?.();
        },
      };
    },
  };
});

import { membersStore, setMembers } from "../../stores/members.store";
import { shellText } from "../../i18n/shell";
import {
  openIdentityMismatchModal,
  ownIdentityTitle,
  verifyPresentation,
} from "./peerVerification";

function verification(
  status: PeerVerification["status"],
  safetyNumber: string | null = null,
  sessionFingerprint: string | null = null,
): PeerVerification {
  return { userId: 7, status, safetyNumber, sessionFingerprint };
}

describe("verifyPresentation", () => {
  it("shows a verified peer with a green shield-check and its safety number", () => {
    expect(verifyPresentation(verification("verified", "12345"))).toEqual({
      icon: "shield-check",
      color: "var(--green, #23a559)",
      title: shellText("identity.verifiedWithNumber", { safetyNumber: "12345" }),
    });
  });

  it("shows a verified peer without a number with the plain verified text", () => {
    expect(verifyPresentation(verification("verified")).title).toBe(shellText("identity.verified"));
  });

  it("shows a peer on a new device with an amber shield-alert and its safety number", () => {
    expect(verifyPresentation(verification("changed", "99887"))).toEqual({
      icon: "shield-alert",
      color: "var(--yellow, #f0b232)",
      title: shellText("identity.newDevice", { safetyNumber: "99887" }),
    });
  });

  it("shows a new device whose number is unknown with an empty number", () => {
    expect(verifyPresentation(verification("changed")).title).toBe(
      shellText("identity.newDevice", { safetyNumber: "" }),
    );
  });

  it("shows a blocked peer with a red shield-alert", () => {
    expect(verifyPresentation(verification("mismatch"))).toEqual({
      icon: "shield-alert",
      color: "var(--red, #f23f43)",
      title: shellText("identity.mismatch"),
    });
  });

  it("shows a peer whose pin store could not be read with an amber shield-question", () => {
    expect(verifyPresentation(verification("unknown"))).toEqual({
      icon: "shield-question",
      color: "var(--yellow, #f0b232)",
      title: shellText("identity.unknown"),
    });
  });

  it("shows a peer with no published key with a muted shield and the session fingerprint", () => {
    expect(verifyPresentation(verification("unverified", null, "ab:cd"))).toEqual({
      icon: "shield",
      color: "var(--text-muted, #949ba4)",
      title: shellText("identity.unverifiedWithFingerprint", { fingerprint: "ab:cd" }),
    });
    expect(verifyPresentation(verification("unverified")).title).toBe(
      shellText("identity.unverified"),
    );
  });
});

describe("ownIdentityTitle", () => {
  it("is null when there is neither a safety number nor a session fingerprint", () => {
    expect(ownIdentityTitle(null, null)).toBeNull();
  });

  it("names the safety number alone, or the session fingerprint alone", () => {
    expect(ownIdentityTitle("111", null)).toBe(
      shellText("channel.ownSafetyNumber", { safetyNumber: "111" }),
    );
    expect(ownIdentityTitle(null, "ff:ee")).toBe(
      shellText("channel.ownSessionFingerprint", { fingerprint: "ff:ee" }),
    );
  });

  it("joins both with a middle dot, the safety number first", () => {
    expect(ownIdentityTitle("111", "ff:ee")).toBe(
      `${shellText("channel.ownSafetyNumber", { safetyNumber: "111" })} · ${shellText("channel.ownSessionFingerprint", { fingerprint: "ff:ee" })}`,
    );
  });
});

describe("openIdentityMismatchModal", () => {
  const overlays = (): NodeListOf<Element> => document.querySelectorAll(".modal-overlay");
  const button = (label: string): HTMLButtonElement => {
    const found = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
    if (found === undefined) throw new Error(`no button ${label}`);
    return found;
  };
  let lifetime: AbortController;

  beforeEach(() => {
    rePinPeerIdentity.mockReset();
    peerAnnouncedIdentityKey.mockReset().mockReturnValue(null);
    showToast.mockReset();
    importIdentityPublicKey
      .mockReset()
      .mockImplementation((key: string) => Promise.resolve(`k:${key}`));
    computeKeyFingerprint
      .mockReset()
      .mockImplementation((key: string) => Promise.resolve(`fp(${key})`));
    setMembers([
      {
        id: 7,
        username: "peer",
        avatar: null,
        role: "member",
        status: "online",
        identity_public_key: "published-key",
      } as never,
    ]);
    lifetime = new AbortController();
  });

  afterEach(() => {
    hooks.onDestroy = null;
    lifetime.abort();
    overlays().forEach((el) => el.remove());
    membersStore.setState((prev) => ({ ...prev, members: new Map() }));
  });

  it("shows the fingerprint of the key the call is using, in preference to the published one", async () => {
    peerAnnouncedIdentityKey.mockReturnValue("announced-key");

    await openIdentityMismatchModal(7, "peer", lifetime.signal);

    expect(computeKeyFingerprint).toHaveBeenCalledWith("k:announced-key");
    expect(overlays()).toHaveLength(1);
    expect(document.body.textContent).toContain("fp(k:announced-key)");
  });

  it("falls back to the member's published key when no announce has been seen", async () => {
    await openIdentityMismatchModal(7, "peer", lifetime.signal);

    expect(importIdentityPublicKey).toHaveBeenCalledWith("published-key");
    expect(document.body.textContent).toContain("fp(k:published-key)");
  });

  it("closes the prompt on Cancel without pinning anything", async () => {
    await openIdentityMismatchModal(7, "peer", lifetime.signal);

    button(shellText("common.cancel")).click();

    expect(overlays()).toHaveLength(0);
    expect(rePinPeerIdentity).not.toHaveBeenCalled();
  });

  it("pins the exact key whose fingerprint was shown, then closes", async () => {
    rePinPeerIdentity.mockResolvedValue(true);
    await openIdentityMismatchModal(7, "peer", lifetime.signal);
    // The member's published key changing during the verification window
    // does not change what gets pinned.
    setMembers([
      {
        id: 7,
        username: "peer",
        avatar: null,
        role: "member",
        status: "online",
        identity_public_key: "swapped-key",
      } as never,
    ]);

    button(shellText("identity.accept")).click();
    await vi.waitFor(() => expect(overlays()).toHaveLength(0));

    expect(rePinPeerIdentity).toHaveBeenCalledExactlyOnceWith(7, "published-key");
    expect(showToast).not.toHaveBeenCalled();
  });

  it("keeps the prompt open and says so when the pin could not be saved", async () => {
    rePinPeerIdentity.mockResolvedValue(false);
    await openIdentityMismatchModal(7, "peer", lifetime.signal);

    button(shellText("identity.accept")).click();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled());

    expect(showToast).toHaveBeenCalledExactlyOnceWith(shellText("identity.rePinFailed"), "error");
    expect(overlays()).toHaveLength(1);
  });

  it("logs and says so when pinning rejects, and keeps the prompt open", async () => {
    const logs = captureLogs();
    rePinPeerIdentity.mockRejectedValue(new Error("keyring locked"));
    await openIdentityMismatchModal(7, "peer", lifetime.signal);

    button(shellText("identity.accept")).click();
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled());

    expect(showToast).toHaveBeenCalledExactlyOnceWith(shellText("identity.rePinFailed"), "error");
    expect(logs.find("E2EE: failed to re-pin peer identity")).toHaveLength(1);
    expect(logs.find("E2EE: failed to re-pin peer identity")[0]).toMatchObject({
      level: "error",
      component: "peer-verification",
    });
    expectConsole("error", /failed to re-pin peer identity/);
    expect(overlays()).toHaveLength(1);
  });

  it("refuses a blind accept when the key has no computable fingerprint", async () => {
    const logs = captureLogs();
    computeKeyFingerprint.mockRejectedValue(new Error("malformed"));
    await openIdentityMismatchModal(7, "peer", lifetime.signal);
    expect(
      logs.find("E2EE: could not compute changed-key fingerprint for re-pin modal"),
    ).toHaveLength(1);
    expectConsole("warn", /could not compute changed-key fingerprint/);

    button(shellText("identity.accept")).click();

    expect(rePinPeerIdentity).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledExactlyOnceWith(shellText("identity.rePinFailed"), "error");
    expect(overlays()).toHaveLength(0);
  });

  it("refuses a blind accept when the server stripped the key", async () => {
    setMembers([
      { id: 7, username: "peer", avatar: null, role: "member", status: "online" } as never,
    ]);
    await openIdentityMismatchModal(7, "peer", lifetime.signal);

    button(shellText("identity.accept")).click();

    expect(computeKeyFingerprint).not.toHaveBeenCalled();
    expect(rePinPeerIdentity).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledExactlyOnceWith(shellText("identity.rePinFailed"), "error");
  });

  it("tears the prompt down when the surface that opened it is destroyed", async () => {
    await openIdentityMismatchModal(7, "peer", lifetime.signal);
    expect(overlays()).toHaveLength(1);

    lifetime.abort();

    expect(overlays()).toHaveLength(0);
  });

  it("replaces an open prompt at once when another one is requested", async () => {
    await openIdentityMismatchModal(7, "peer", lifetime.signal);
    const first = overlays()[0]!;
    let release!: (fingerprint: string) => void;
    computeKeyFingerprint.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );

    const second = openIdentityMismatchModal(7, "peer", lifetime.signal);
    await Promise.resolve();
    expect(first.isConnected).toBe(false);
    release("fp-second");
    await second;

    expect(overlays()).toHaveLength(1);
  });

  it("leaves a single prompt when two requests overlap", async () => {
    const releases: Array<(fingerprint: string) => void> = [];
    computeKeyFingerprint.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releases.push(resolve);
        }),
    );
    const other = new AbortController();

    const a = openIdentityMismatchModal(7, "peer", lifetime.signal);
    const b = openIdentityMismatchModal(7, "peer", other.signal);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!("fp-b");
    await b;
    expect(overlays()).toHaveLength(1);
    releases[0]!("fp-a");
    await a;

    expect(overlays()).toHaveLength(1);
    expect(document.body.textContent).toContain("fp-a");
    expect(document.body.textContent).not.toContain("fp-b");
    other.abort();
  });

  it("opens nothing when the surface is destroyed while the fingerprint is computed", async () => {
    let release!: (fingerprint: string) => void;
    computeKeyFingerprint.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );

    const opening = openIdentityMismatchModal(7, "peer", lifetime.signal);
    await Promise.resolve();
    lifetime.abort();
    release("fp");
    await opening;

    expect(overlays()).toHaveLength(0);
  });
  it("opens nothing when the surface is destroyed after the older prompt was cleared away", async () => {
    const releases: Array<(fingerprint: string) => void> = [];
    computeKeyFingerprint.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releases.push(resolve);
        }),
    );
    const doomed = new AbortController();
    const other = new AbortController();

    const first = openIdentityMismatchModal(7, "peer", doomed.signal);
    const second = openIdentityMismatchModal(7, "peer", other.signal);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!("fp-second");
    await second;
    expect(overlays()).toHaveLength(1);
    // Clearing the second prompt away is the instant the first surface goes.
    hooks.onDestroy = () => doomed.abort();
    releases[0]!("fp-first");
    await first;

    expect(overlays()).toHaveLength(0);
    other.abort();
  });
  it("leaves a newer prompt open when the surface that asked first is destroyed meanwhile", async () => {
    const releases: Array<(fingerprint: string) => void> = [];
    computeKeyFingerprint.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releases.push(resolve);
        }),
    );
    const doomed = new AbortController();
    const first = openIdentityMismatchModal(7, "peer", doomed.signal);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    await openIdentityMismatchModal(7, "peer", lifetime.signal);
    expect(overlays()).toHaveLength(1);

    doomed.abort();
    releases[0]!("fp-first");
    await first;

    expect(overlays()).toHaveLength(1);
    expect(document.body.textContent).toContain("fp(k:published-key)");
  });
});
