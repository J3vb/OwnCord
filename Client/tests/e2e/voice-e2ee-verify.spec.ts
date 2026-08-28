import { test, expect, type Page } from "@playwright/test";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  MOCK_MESSAGES,
  MOCK_CHANNELS_WITH_CATEGORIES,
  MOCK_MEMBERS_MULTI_ROLE,
  MOCK_VOICE_STATE,
  navigateToMainPageReady,
  joinVoiceChannelByName,
  emitWsMessage,
} from "./helpers";

// ---------------------------------------------------------------------------
// Tests: voice E2EE identity-verification surface (DC-04, spec:
// docs/architecture/ux/voice-and-e2ee.md §7)
//
// Covers the roster badge states (verified / unverified / mismatch / unknown)
// and the identity-mismatch modal journey (review → reject keeps the peer
// blocked; trust re-pins the displayed key). The peer's announce is REAL
// crypto — an ECDSA P-256 identity key signing an ECDH ephemeral key exactly
// as e2eeCrypto.signEphemeralKey does — so the badge states come out of the
// production verification path, not a shortcut.
//
// Harness notes:
// - Verification only runs once the local ECDH keypair exists, which requires
//   a voice_token; the stock voiceWsHandlers deliberately withhold it. This
//   spec's voice_join handler DOES send one with is_key_holder: true (the key
//   holder path returns from setupKeyExchange immediately), and a WebSocket
//   shim parks the resulting LiveKit room.connect forever so the session sits
//   stably in "securing" instead of self-destructing mid-test.
// - Announces may be emitted before joining: handleAnnounce queues them until
//   the keypair exists and setupKeyExchange drains the queue through the
//   verifying path, so there is no race either way.
// ---------------------------------------------------------------------------

const subtle = globalThis.crypto.subtle;

interface PeerCrypto {
  /** The peer's long-term identity public key (raw P-256, base64). */
  identityPublicKeyB64: string;
  /** The peer's ephemeral ECDH public key for this call (raw P-256, base64). */
  ephemeralPublicKeyB64: string;
  /** ECDSA signature over domain ‖ userId ‖ ephemeralRaw, base64. */
  signatureB64: string;
}

/** Generate a peer's identity + ephemeral keys and the signed announce,
 *  mirroring e2eeCrypto.signEphemeralKey's message construction exactly. */
async function makePeerCrypto(userId: number): Promise<PeerCrypto> {
  const identity = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const ephemeral = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const idPubRaw = new Uint8Array(await subtle.exportKey("raw", identity.publicKey));
  const ephPubRaw = new Uint8Array(await subtle.exportKey("raw", ephemeral.publicKey));

  const domain = new TextEncoder().encode("owncord-voice-e2ee-announce-v1");
  const uid = new TextEncoder().encode(String(userId));
  const message = new Uint8Array(domain.length + uid.length + ephPubRaw.length);
  message.set(domain, 0);
  message.set(uid, domain.length);
  message.set(ephPubRaw, domain.length + uid.length);
  const sig = new Uint8Array(
    await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.privateKey, message),
  );

  return {
    identityPublicKeyB64: Buffer.from(idPubRaw).toString("base64"),
    ephemeralPublicKeyB64: Buffer.from(ephPubRaw).toString("base64"),
    signatureB64: Buffer.from(sig).toString("base64"),
  };
}

/** voice_join reply that, unlike the stock voiceWsHandlers, also grants a
 *  voice_token — required to mint the local ECDH keypair that gates
 *  verification. is_key_holder: true avoids the non-key-holder's 15s stall. */
function voiceJoinWithTokenHandler(): { type: string; handler: string } {
  return {
    type: "voice_join",
    handler: `
      var p = parsed.payload;
      setTimeout(function() {
        __tauriEmitEvent("ws-message", JSON.stringify({
          type: "voice_state",
          payload: { user_id: 1, channel_id: p.channel_id, username: "testuser", muted: false, deafened: false, speaking: false, camera: false, screenshare: false }
        }));
      }, 50);
      setTimeout(function() {
        __tauriEmitEvent("ws-message", JSON.stringify({
          type: "voice_token",
          payload: { token: "mock-token", url: "ws://localhost:7880", channel_id: p.channel_id, direct_url: "", is_key_holder: true }
        }));
      }, 80);
    `,
  };
}

/** Mock session where remote user 2 ("moderator1") is in the voice channel and
 *  may carry a published identity key and/or a stored pin. */
async function mockE2EEVoiceSession(
  page: Page,
  opts: {
    peerIdentityKeyB64?: string;
    identityPins?: Record<string, string>;
    identityPinError?: boolean;
  },
): Promise<void> {
  const members = MOCK_MEMBERS_MULTI_ROLE.map((m) =>
    m.id === 2 && opts.peerIdentityKeyB64 !== undefined
      ? { ...m, identity_public_key: opts.peerIdentityKeyB64 }
      : m,
  );
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: MOCK_MESSAGES },
      ],
      simulateWsFlow: true,
      wsHandlers: [voiceJoinWithTokenHandler()],
      readyOverrides: {
        channels: MOCK_CHANNELS_WITH_CATEGORIES,
        members,
        voice_states: MOCK_VOICE_STATE,
      },
      identityPins: opts.identityPins,
      identityPinError: opts.identityPinError,
    }),
  );
  // Park the LiveKit signal WebSocket forever: room.connect neither succeeds
  // nor fails during the test, so the voice session stays in "securing" and
  // never tears down the verification state mid-assertion.
  await page.addInitScript(() => {
    const RealWS = window.WebSocket;
    function ParkedOrReal(url: string | URL, protocols?: string | string[]): WebSocket {
      const s = String(url);
      if (s.includes("localhost:7880") || s.includes("127.0.0.1:7880")) {
        const parked = new EventTarget() as unknown as Record<string, unknown>;
        parked.url = s;
        parked.readyState = 0; // CONNECTING, forever
        parked.binaryType = "arraybuffer";
        parked.send = () => {};
        parked.close = () => {
          parked.readyState = 3;
        };
        parked.onopen = null;
        parked.onmessage = null;
        parked.onerror = null;
        parked.onclose = null;
        return parked as unknown as WebSocket;
      }
      return new RealWS(url, protocols);
    }
    ParkedOrReal.prototype = RealWS.prototype;
    Object.assign(ParkedOrReal, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    (window as unknown as { WebSocket: unknown }).WebSocket = ParkedOrReal;
  });
}

async function emitPeerAnnounce(
  page: Page,
  userId: number,
  crypto: PeerCrypto,
  withSignature = true,
): Promise<void> {
  await emitWsMessage(page, {
    type: "voice_e2ee_announce",
    payload: {
      user_id: userId,
      public_key: crypto.ephemeralPublicKeyB64,
      ...(withSignature ? { signature: crypto.signatureB64 } : {}),
    },
  });
}

/** IPC calls of one command recorded by the mock's invoke log. */
async function invokesOf(page: Page, cmd: string): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(
    (c) =>
      (
        window as unknown as { __invokeLog: Array<{ cmd: string; args: Record<string, unknown> }> }
      ).__invokeLog
        .filter((e) => e.cmd === c)
        .map((e) => e.args),
    cmd,
  );
}

const peerBadge = (page: Page): ReturnType<Page["locator"]> =>
  page.locator('.voice-user-item[data-voice-uid="2"] .vu-verify');

test.describe("Voice E2EE identity verification (§7)", () => {
  test("a valid signed announce verifies the peer: green badge with safety number, pinned on first sight", async ({
    page,
  }) => {
    const peer = await makePeerCrypto(2);
    await mockE2EEVoiceSession(page, { peerIdentityKeyB64: peer.identityPublicKeyB64 });
    await page.goto("/");
    await navigateToMainPageReady(page);

    await emitPeerAnnounce(page, 2, peer);
    await joinVoiceChannelByName(page);

    const badge = peerBadge(page);
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveClass(/verified/);
    await expect(badge).toHaveAttribute("title", /^Identity verified · Safety number: /);

    // TOFU: the first verified sighting pins the peer's identity key.
    const pins = await invokesOf(page, "store_identity_pin");
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ userId: "2", pin: peer.identityPublicKeyB64 });
  });

  test("a legacy peer with no published key is accepted but shows the neutral unverified badge", async ({
    page,
  }) => {
    const peer = await makePeerCrypto(2);
    await mockE2EEVoiceSession(page, {}); // no identity_public_key on member 2
    await page.goto("/");
    await navigateToMainPageReady(page);

    await emitPeerAnnounce(page, 2, peer, false);
    await joinVoiceChannelByName(page);

    const badge = peerBadge(page);
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveClass(/unverified/);
    // No identity key → no safety number, but the per-call session
    // fingerprint is shown (labelled as not an identity) so there is still
    // something to compare out of band (OC-0003).
    await expect(badge).toHaveAttribute(
      "title",
      /^Identity not verified — this participant published no key\. Session fingerprint \(changes every call — not an identity\): ([0-9A-F]{4} ){7}[0-9A-F]{4}$/,
    );
    expect(await invokesOf(page, "store_identity_pin")).toHaveLength(0);
  });

  test("a pinned peer whose delivered key changed is blocked with the red mismatch badge", async ({
    page,
  }) => {
    const peer = await makePeerCrypto(2);
    const oldPin = (await makePeerCrypto(2)).identityPublicKeyB64; // a different, previously-pinned key
    await mockE2EEVoiceSession(page, {
      peerIdentityKeyB64: peer.identityPublicKeyB64,
      identityPins: { "2": oldPin },
    });
    await page.goto("/");
    await navigateToMainPageReady(page);

    await emitPeerAnnounce(page, 2, peer);
    await joinVoiceChannelByName(page);

    const badge = peerBadge(page);
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveClass(/mismatch/);
    await expect(badge).toHaveAttribute(
      "title",
      "Identity key changed — click to review and re-pin",
    );
    // Blocked means blocked: nothing was re-pinned behind the user's back.
    expect(await invokesOf(page, "store_identity_pin")).toHaveLength(0);
  });

  test("mismatch modal journey — reject (Cancel) keeps the peer blocked", async ({ page }) => {
    const peer = await makePeerCrypto(2);
    const oldPin = (await makePeerCrypto(2)).identityPublicKeyB64;
    await mockE2EEVoiceSession(page, {
      peerIdentityKeyB64: peer.identityPublicKeyB64,
      identityPins: { "2": oldPin },
    });
    await page.goto("/");
    await navigateToMainPageReady(page);
    await emitPeerAnnounce(page, 2, peer);
    await joinVoiceChannelByName(page);

    const badge = peerBadge(page);
    await expect(badge).toHaveClass(/mismatch/, { timeout: 10_000 });
    await badge.click();

    // The modal shows the participant and the NEW key's fingerprint so the
    // user can verify it out-of-band before trusting.
    await expect(page.locator("h3", { hasText: "Identity Warning" })).toBeVisible();
    await expect(page.locator(".cert-title")).toHaveText("Identity Key Changed");
    await expect(page.locator(".cert-details")).toContainText("moderator1");
    await expect(page.locator(".cert-details .cert-fingerprint")).toBeVisible();

    await page.locator(".modal-footer button", { hasText: "Cancel" }).click();

    await expect(page.locator("h3", { hasText: "Identity Warning" })).toBeHidden();
    // Reject leaves the peer blocked for E2EE media: badge stays red, no pin write.
    await expect(badge).toHaveClass(/mismatch/);
    expect(await invokesOf(page, "store_identity_pin")).toHaveLength(0);
  });

  test("mismatch modal journey — Trust New Key re-pins the displayed key and clears the block", async ({
    page,
  }) => {
    const peer = await makePeerCrypto(2);
    const oldPin = (await makePeerCrypto(2)).identityPublicKeyB64;
    await mockE2EEVoiceSession(page, {
      peerIdentityKeyB64: peer.identityPublicKeyB64,
      identityPins: { "2": oldPin },
    });
    await page.goto("/");
    await navigateToMainPageReady(page);
    await emitPeerAnnounce(page, 2, peer);
    await joinVoiceChannelByName(page);

    const badge = peerBadge(page);
    await expect(badge).toHaveClass(/mismatch/, { timeout: 10_000 });
    await badge.click();
    await expect(page.locator("h3", { hasText: "Identity Warning" })).toBeVisible();

    await page.locator(".modal-footer button", { hasText: "Trust New Key" }).click();

    await expect(page.locator("h3", { hasText: "Identity Warning" })).toBeHidden();
    // The EXACT displayed key was pinned (TOCTOU-safe re-pin), and the
    // mismatch block cleared. Re-pinning replays the announce that was
    // blocked as a mismatch (OC-0212), which re-verifies against the pin just
    // stored — so the peer lands in the verified state rather than losing its
    // badge entirely. The badge must not simply disappear: a mid-call peer
    // never re-announces on its own, so an empty badge would mean the peer
    // stayed un-keyed for the rest of the call while the UI showed nothing.
    await expect(badge).toBeVisible();
    await expect(badge).toHaveClass(/verified/);
    await expect(badge).toHaveAttribute("title", /^Identity verified · Safety number: /);
    const pins = await invokesOf(page, "store_identity_pin");
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ userId: "2", pin: peer.identityPublicKeyB64 });
  });

  test("an unreadable pin store fails closed: distinct 'could not check' badge, nothing pinned (DC-08)", async ({
    page,
  }) => {
    const peer = await makePeerCrypto(2);
    await mockE2EEVoiceSession(page, {
      peerIdentityKeyB64: peer.identityPublicKeyB64,
      identityPinError: true,
    });
    await page.goto("/");
    await navigateToMainPageReady(page);

    await emitPeerAnnounce(page, 2, peer);
    await joinVoiceChannelByName(page);

    const badge = peerBadge(page);
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveClass(/unknown/);
    await expect(badge).toHaveAttribute("title", /Could not check/);
    // Fail closed: a storage fault must never read as "never pinned" — the
    // valid-looking key is NOT verified and NOT pinned.
    await expect(badge).not.toHaveClass(/verified/);
    expect(await invokesOf(page, "store_identity_pin")).toHaveLength(0);
  });
});
