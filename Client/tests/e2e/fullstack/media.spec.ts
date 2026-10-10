import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { expectDecodedMedia, joinVoice, mediaStats } from "../support/media";
import { openSettings, switchSettingsTab } from "../helpers";

test.use({ media: true });
test.setTimeout(180_000);

// ---------------------------------------------------------------------------
// Video grid (audit batch N6, gap #8)
//
// The mocked `video-grid.spec.ts` owns the chat/grid toggle, which needs no
// LiveKit. Tiles, focus mode and the tile audio controls only exist once a
// real room is delivering real tracks, so they are proven here against the
// real server + SFU. Every assertion is on rendered DOM, on the app's own
// LiveKit state (the production `__owncord.lkDebug()` introspection), or on
// the outgoing WS frames the client actually sent — never on a test hook.
// ---------------------------------------------------------------------------

/** Offset added to a user id to form their screenshare tile id. */
const SCREENSHARE_TILE_ID_OFFSET = 1_000_000;

/** Remote mic volume the app actually applied, from its own debug introspection
 *  (LiveKit's GainNode volume), not from a test-owned value. */
async function remoteMicVolume(page: Page, userId: number): Promise<number | undefined> {
  return page.evaluate((uid) => {
    const info = (
      window as unknown as {
        __owncord: {
          lkDebug: () => { remoteParticipants: Array<{ userId: number; volume: number }> };
        };
      }
    ).__owncord.lkDebug();
    return info.remoteParticipants.find((p) => p.userId === uid)?.volume;
  }, userId);
}

/** Capture the client's outgoing WS frames through the real transport. */
function captureFrames(transport: {
  observeClientMessages: (
    observer?: (message: { type: string; payload?: Record<string, unknown> }) => void,
  ) => void;
}): Array<{ type: string; payload?: Record<string, unknown> }> {
  const frames: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  transport.observeClientMessages((message) => frames.push(message));
  return frames;
}

test("a real remote camera produces a labelled tile while the local self tile has no audio controls", async ({
  alice,
  bob,
}) => {
  await joinVoice(alice);
  await joinVoice(bob);
  await expectDecodedMedia(alice);

  // The local camera is the only path that auto-opens the grid; the self tile
  // is deliberately control-free (you cannot mute yourself).
  await alice.locator(".voice-widget button[aria-label='Camera']").click();
  const gridSlot = alice.locator("[data-testid='video-grid-slot']");
  await expect(gridSlot).toBeVisible({ timeout: 10_000 });
  const selfTile = alice.locator(".video-cell[data-user-id='1']");
  await expect(selfTile).toBeVisible({ timeout: 10_000 });
  await expect(selfTile.locator(".video-username")).toHaveText("alice (You)");
  await expect(selfTile).toHaveAttribute("data-stream-type", "camera");
  await expect(selfTile.locator(".video-tile-overlay")).toHaveCount(0);

  // A real remote camera arrives as its own tile with audio controls, and its
  // media actually decodes on this client.
  const bobTile = alice.locator(".video-cell[data-user-id='2']");
  await bob.locator(".voice-widget button[aria-label='Camera']").click();
  await expect(bobTile).toBeVisible({ timeout: 10_000 });
  await expect(bobTile.locator(".video-username")).toHaveText("bob");
  await expect(bobTile.locator(".tile-mute-btn")).toBeVisible();
  await expectDecodedMedia(alice, true);

  // Plain grid layout, not focus mode: both tiles live directly under the grid.
  await expect(alice.locator("[data-testid='video-grid']")).not.toHaveClass(/focus-mode/);
});

test("watching a stream focuses its tile, and clicking a thumbnail switches focus", async ({
  alice,
  bob,
}) => {
  await joinVoice(alice);
  await joinVoice(bob);
  await expectDecodedMedia(alice);

  // Two tiles on alice: her own camera plus bob's remote camera.
  await alice.locator(".voice-widget button[aria-label='Camera']").click();
  await expect(alice.locator(".video-cell[data-user-id='1']")).toBeVisible({ timeout: 10_000 });
  await bob.locator(".voice-widget button[aria-label='Camera']").click();
  await expectDecodedMedia(alice, true);

  // The sidebar watch affordance focuses the peer's tile.
  const bobRow = alice.locator(".voice-user-item[data-voice-uid='2']");
  await expect(bobRow.locator(".vu-status")).toBeVisible({ timeout: 10_000 });
  await bobRow.click();
  const grid = alice.locator("[data-testid='video-grid']");
  await expect(grid).toHaveClass(/focus-mode/, { timeout: 5_000 });
  await expect(alice.locator(".video-focus-main .video-cell[data-user-id='2']")).toHaveClass(
    /focused/,
  );
  await expect(alice.locator(".video-focus-strip .video-cell[data-user-id='1']")).toHaveClass(
    /thumb/,
  );

  // Clicking the thumbnail promotes it into the main area and demotes the other.
  await alice.locator(".video-focus-strip .video-cell[data-user-id='1']").click();
  await expect(alice.locator(".video-focus-main .video-cell[data-user-id='1']")).toHaveClass(
    /focused/,
  );
  await expect(alice.locator(".video-focus-strip .video-cell[data-user-id='2']")).toHaveClass(
    /thumb/,
  );
});

/** Open `page`'s grid on a peer's camera from their voice roster row. A
 *  closed grid receives no video (P3-07), so decoded video needs a watcher. */
async function watchCamera(page: Page, userId: number): Promise<void> {
  const row = page.locator(`.voice-user-item[data-voice-uid='${String(userId)}']`);
  await expect(row.locator(".vu-status")).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(page.locator(`.video-cell[data-user-id='${String(userId)}']`)).toBeVisible();
}

/** Inbound video bytes this page received over `ms`. */
async function videoBytesOver(page: Page, ms: number): Promise<number> {
  const before = (await mediaStats(page)).videoBytes;
  await page.waitForTimeout(ms);
  return (await mediaStats(page)).videoBytes - before;
}

test("a remote camera sends no video while the grid is closed, and resumes when it is shown", async ({
  alice,
  bob,
}) => {
  await joinVoice(alice);
  await joinVoice(bob);
  await expectDecodedMedia(alice);

  // Bob's camera becomes a tile in alice's grid, which stays closed: only a
  // local camera opens it (BUG-105).
  await bob.locator(".voice-widget button[aria-label='Camera']").click();
  const gridSlot = alice.locator("[data-testid='video-grid-slot']");
  const bobTile = alice.locator(".video-cell[data-user-id='2']");
  await expect(bobTile).toBeAttached({ timeout: 10_000 });
  await expect(gridSlot).toBeHidden();
  // Let the disable reach the SFU and any in-flight frames drain.
  await alice.waitForTimeout(1_500);
  const closed = await videoBytesOver(alice, 3_000);

  // Watching bob opens the grid on his tile: his video decodes again.
  await watchCamera(alice, 2);
  await expectDecodedMedia(alice, true);
  const shown = await videoBytesOver(alice, 3_000);
  expect(closed).toBeLessThan(shown / 10);

  // Back to the chat: the video stops again, and comes back on the next watch.
  await alice.locator("[data-tile-control='exit-grid']").click();
  await expect(gridSlot).toBeHidden();
  await alice.waitForTimeout(1_500);
  expect(await videoBytesOver(alice, 3_000)).toBeLessThan(shown / 10);
  await watchCamera(alice, 2);
  await expectDecodedMedia(alice, true);
});

test("a tile's mute button and volume slider change the peer's real playback volume", async ({
  alice,
  bob,
}) => {
  await joinVoice(alice);
  await joinVoice(bob);
  await expectDecodedMedia(alice);

  await alice.locator(".voice-widget button[aria-label='Camera']").click();
  await bob.locator(".voice-widget button[aria-label='Camera']").click();
  await expectDecodedMedia(alice, true);
  const tile = alice.locator(".video-cell[data-user-id='2']");
  await expect(tile).toBeVisible({ timeout: 10_000 });

  const muteBtn = tile.locator(".tile-mute-btn");
  await expect(muteBtn).toHaveAttribute("aria-label", "Mute");
  await expect.poll(() => remoteMicVolume(alice, 2)).toBe(1);

  // Mute: the button flips and the peer's real LiveKit volume drops to zero.
  await muteBtn.click();
  await expect(muteBtn).toHaveAttribute("aria-label", "Unmute");
  await expect.poll(() => remoteMicVolume(alice, 2), { timeout: 5_000 }).toBe(0);
  await expect(tile.locator(".video-tile-overlay")).toHaveClass(/muted/);

  // Unmute restores the pre-mute level.
  await muteBtn.click();
  await expect(muteBtn).toHaveAttribute("aria-label", "Mute");
  await expect.poll(() => remoteMicVolume(alice, 2), { timeout: 5_000 }).toBe(1);

  // The slider drives the real volume: gain is value/100, so 50 → 0.5.
  const slider = tile.locator(".tile-volume-slider");
  await slider.evaluate((el: HTMLInputElement) => {
    el.value = "50";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(() => remoteMicVolume(alice, 2), { timeout: 5_000 }).toBe(0.5);

  // Sliding to zero is a mute in effect: the button reflects it.
  await slider.evaluate((el: HTMLInputElement) => {
    el.value = "0";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(muteBtn).toHaveAttribute("aria-label", "Unmute");
  await expect.poll(() => remoteMicVolume(alice, 2), { timeout: 5_000 }).toBe(0);
});

test("starting and stopping a screen share publishes a labelled screenshare tile and tears it down", async ({
  alice,
  bob,
  aliceTransport,
}) => {
  await joinVoice(alice);
  await joinVoice(bob);
  await expectDecodedMedia(alice);
  const outbound = captureFrames(aliceTransport);

  const shareBtn = alice.locator(".voice-widget button[aria-label='Screenshare']");
  await shareBtn.click();

  // Local UI: the control reports sharing and a self screen tile (offset id)
  // is published under the grid, which auto-opens for local video.
  // The active state lives on the button itself (aria-pressed + the
  // active-control tint); the redesign removed the "Sharing" text label.
  await expect(shareBtn).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  await expect(shareBtn).toHaveClass(/active-ctrl/);
  const selfScreen = alice.locator(`.video-cell[data-user-id='${1 + SCREENSHARE_TILE_ID_OFFSET}']`);
  await expect(selfScreen).toBeVisible({ timeout: 10_000 });
  await expect(selfScreen).toHaveAttribute("data-stream-type", "screenshare");
  await expect(selfScreen.locator(".video-username")).toHaveText("alice (Screen)");
  await expect(alice.locator("[data-testid='video-grid-slot']")).toBeVisible();
  expect(
    outbound.some((f) => f.type === "voice_screenshare" && f.payload?.enabled === true),
    "starting a share must announce voice_screenshare(enabled: true)",
  ).toBe(true);

  // Remote side: the peer can watch the real screenshare and actually decodes
  // its video frames.
  const aliceRow = bob.locator(".voice-user-item[data-voice-uid='1']");
  await expect(aliceRow.locator(".vu-live-badge")).toBeVisible({ timeout: 10_000 });
  await aliceRow.click();
  await expect(bob.locator("[data-testid='video-grid-slot']")).toBeVisible({ timeout: 5_000 });
  const bobScreen = bob.locator(
    "[data-testid='video-grid'] .video-cell[data-stream-type='screenshare']",
  );
  await expect(bobScreen).toBeVisible({ timeout: 10_000 });
  await expect(bobScreen.locator(".video-username")).toHaveText("alice (Screen)");
  await expectDecodedMedia(bob, true);

  // Stop: UI clears, the announcement goes out, and every tile/stream is gone.
  await shareBtn.click();
  await expect(shareBtn).toHaveAttribute("aria-pressed", "false", { timeout: 20_000 });
  await expect(shareBtn).not.toHaveClass(/active-ctrl/);
  await expect(selfScreen).toHaveCount(0);
  await expect(alice.locator("[data-testid='video-grid'] .video-cell")).toHaveCount(0);
  await expect(alice.locator("[data-testid='video-grid-slot']")).toBeHidden();
  await expect(bobScreen).toHaveCount(0, { timeout: 10_000 });
  expect(
    outbound.some((f) => f.type === "voice_screenshare" && f.payload?.enabled === false),
    "stopping a share must announce voice_screenshare(enabled: false)",
  ).toBe(true);
});

// A pop-out holds the stream's own <video>: when the stream ends, by any path,
// the window goes with it rather than staying open on a dead frame.
const shareEndings: Array<[string, (alice: Page, bob: Page) => Promise<void>]> = [
  [
    "the sharer stops sharing",
    (alice) => alice.locator(".voice-widget button[aria-label='Screenshare']").click(),
  ],
  [
    "the sharer leaves voice",
    (alice) => alice.locator(".voice-widget.visible button[aria-label='Disconnect']").click(),
  ],
  ["the sharer's app goes away", (alice) => alice.close()],
  [
    "the watcher leaves voice",
    (_alice, bob) => bob.locator(".voice-widget.visible button[aria-label='Disconnect']").click(),
  ],
];

for (const [ending, end] of shareEndings) {
  test(`a popped-out screen share closes its window when ${ending}`, async ({ alice, bob }) => {
    await joinVoice(alice);
    await joinVoice(bob);
    const shareBtn = alice.locator(".voice-widget button[aria-label='Screenshare']");
    await shareBtn.click();
    await expect(shareBtn).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });

    const aliceRow = bob.locator(".voice-user-item[data-voice-uid='1']");
    await expect(aliceRow.locator(".vu-live-badge")).toBeVisible({ timeout: 10_000 });
    await aliceRow.click();
    const bobScreen = bob.locator(
      "[data-testid='video-grid'] .video-cell[data-stream-type='screenshare']",
    );
    await expect(bobScreen).toBeVisible({ timeout: 10_000 });
    await bobScreen.hover();
    const [popup] = await Promise.all([
      bob.waitForEvent("popup"),
      bobScreen.locator("[data-tile-control='pip']").click(),
    ]);
    await expect(popup.locator(".video-popout video")).toHaveCount(1);

    await end(alice, bob);

    await expect.poll(() => popup.isClosed(), { timeout: 15_000 }).toBe(true);
    await expect(bobScreen).toHaveCount(0);
  });
}

test("guided diagnostics observes actual decoded incoming media without leaving extra capture", async ({
  alice,
  bob,
}) => {
  await joinVoice(alice);
  await joinVoice(bob);
  await expectDecodedMedia(alice);
  const before = await mediaStats(alice);
  await openSettings(alice);
  await switchSettingsTab(alice, "Logs");
  await alice.getByRole("button", { name: "Start connection test", exact: true }).click();
  await expect(alice.getByTestId("diagnostics-status")).toContainText("Test complete");
  await expect(alice.getByTestId("diagnostic-signaling")).toHaveAttribute("data-status", "passed");
  await expect(alice.getByTestId("diagnostic-media")).toHaveAttribute("data-status", "passed");
  await expect(alice.getByTestId("diagnostic-media")).toContainText("Incoming audio decoded");
  expect((await mediaStats(alice)).liveCapture).toBe(before.liveCapture);
});

test("encrypted media recovers from LiveKit signaling loss and application reconnect", async ({
  alice,
  bob,
  aliceTransport,
}) => {
  await joinVoice(alice);
  await joinVoice(bob);
  await expectDecodedMedia(alice);
  await expectDecodedMedia(bob);
  await alice.locator(".voice-widget button[aria-label='Camera']").click();
  await watchCamera(bob, 1);
  await expectDecodedMedia(bob, true);
  const baseline = await mediaStats(alice);
  const signalCount = await alice.evaluate(() => window.__ocMedia.signaling.length);
  await alice.evaluate(() => {
    const socket = window.__ocMedia.signaling.find((ws) => ws.readyState === WebSocket.OPEN);
    if (!socket) throw new Error("No live LiveKit signaling connection");
    socket.close(4000, "E2E signaling interruption");
  });
  await expect
    .poll(() => alice.evaluate(() => window.__ocMedia.signaling.length))
    .toBeGreaterThan(signalCount);
  await expectDecodedMedia(bob, true);
  expect((await mediaStats(alice)).senders).toBe(baseline.senders);

  // RT-8: a brief socket blip no longer ends the call. The server parks the
  // membership for a grace window and the resume inherits it, so the widget
  // stays up and media keeps flowing without a manual rejoin or key exchange.
  await aliceTransport.offline();
  await expect(alice.locator(".reconnecting-banner")).toBeVisible();
  aliceTransport.online();
  await expect(alice.locator(".reconnecting-banner")).not.toBeVisible();
  await expect(alice.locator(".voice-widget")).toHaveClass(/visible/);
  await expectDecodedMedia(bob, true);
  expect((await mediaStats(alice)).senders).toBe(baseline.senders);

  // A blip longer than the grace window does end the membership: the expiry
  // removes the SFU participant, which ends the client's LiveKit room. P2-T5:
  // the voice reconnect loop then sees the released membership once the chat
  // socket is back and rejoins on its own — a fresh authorized join and key
  // exchange, with the camera off as after any join.
  await aliceTransport.offline();
  await expect(alice.locator(".reconnecting-banner")).toBeVisible();
  await alice.waitForTimeout(16_000); // outlast the 15 s server grace window
  aliceTransport.online();
  await expect(alice.locator(".reconnecting-banner")).not.toBeVisible();
  await expect(alice.locator(".voice-widget.visible")).toContainText("Voice Connected", {
    timeout: 45_000,
  });
  await expectDecodedMedia(alice);
  await alice.locator(".voice-widget button[aria-label='Camera']").click();
  await watchCamera(bob, 1);
  await expectDecodedMedia(bob, true);
  expect((await mediaStats(alice)).senders).toBe(baseline.senders);

  await joinVoice(alice, "voice-two");
  await joinVoice(bob, "voice-two");
  await expectDecodedMedia(alice);
  await expectDecodedMedia(bob);
  await alice.locator(".voice-widget button[aria-label='Disconnect']").click();
  await expect.poll(async () => (await mediaStats(alice)).liveCapture).toBe(0);
  await expect.poll(async () => (await mediaStats(alice)).senders).toBe(0);
});

test("microphone denial offers recovery and device removal produces the application toast", async ({
  alice,
  bob,
}) => {
  await alice.evaluate(() => {
    window.__ocMedia.denyMic = true;
  });
  await joinVoice(alice);
  await joinVoice(bob);
  const grant = alice.getByRole("button", { name: "Grant microphone permission", exact: true });
  await expect(grant).toBeVisible();
  await alice.evaluate(() => {
    window.__ocMedia.denyMic = false;
  });
  await grant.click();
  await expect(grant).toBeHidden();
  await expectDecodedMedia(bob);

  await alice.evaluate(() => {
    localStorage.setItem(
      "owncord:settings:audioInputDevice",
      JSON.stringify("removed-test-microphone"),
    );
    navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
  });
  await expect(
    alice
      .getByTestId("toast")
      .filter({ hasText: "Audio device disconnected — switched to default" }),
  ).toBeVisible();
  await expectDecodedMedia(bob);
});

test("a quality crash updates the readout without opening the stats pane", async ({
  alice,
  bob,
}) => {
  await joinVoice(alice);
  await joinVoice(bob);
  await expectDecodedMedia(alice);
  await expect(alice.locator(".vw-stats")).not.toHaveClass(/visible/);
  await alice.evaluate(() => {
    window.__ocMedia.poorQuality = true;
  });
  // The degraded RTT reaches the ping readout, but the pane is on-demand:
  // only a click on the signal icon opens it.
  await expect(alice.locator(".vw-signal .vw-ping")).toHaveText("800ms");
  // Outlast the 3 s quality debounce, so an auto-expand on the quality change
  // would have fired before the pane is checked.
  await alice.waitForTimeout(4_000);
  await expect(alice.locator(".vw-stats")).not.toHaveClass(/visible/);
  await alice.locator(".vw-signal").click();
  await expect(alice.locator(".vw-stats")).toHaveClass(/visible/);
  await expect(alice.locator(".vw-stats")).toContainText("800");
});

for (const fault of ["missing", "wrong"] as const) {
  test(`${fault} media key prevents decoding without plaintext fallback`, async ({
    alice,
    bob,
  }) => {
    await bob.evaluate((fault) => {
      window.__ocMedia.keyFault = fault;
    }, fault);
    await joinVoice(alice);
    await joinVoice(bob);
    await alice.locator(".voice-widget button[aria-label='Camera']").click();
    await expect.poll(() => bob.evaluate(() => window.__ocMedia.keyMessages)).toBeGreaterThan(0);
    await expect
      .poll(() => bob.evaluate(() => window.__ocMedia.decodeTransforms))
      .toBeGreaterThan(0);
    await expect.poll(async () => (await mediaStats(alice)).sentBytes).toBeGreaterThan(0);
    // A bounded observation window is essential for this negative property.
    // Keep checking throughout it: an immediate zero would pass before packets arrive.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const stats = await mediaStats(bob);
      expect(stats.audioEnergy).toBe(0);
      expect(stats.videoFrames).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await bob.evaluate(() => window.__ocMedia.plaintextEnables)).toBe(0);
    await openSettings(bob);
    await switchSettingsTab(bob, "Logs");
    await bob.getByRole("button", { name: "Start connection test", exact: true }).click();
    await expect(bob.getByTestId("diagnostics-status")).toContainText("Test complete");
    // The fault is real: the diagnostic must have run and found no decodable
    // media — "not-tested" with the observed-nothing detail. The old
    // /^(failed|not-tested)$/ regex also accepted "not-tested" but as a loose
    // OR; pin the exact status so "the diagnostic never ran" cannot pass.
    await expect(bob.getByTestId("diagnostic-media")).toHaveAttribute("data-status", "not-tested");
    await expect(bob.getByTestId("diagnostic-media")).toContainText("No advancing decoded media");
    await bob.locator(".settings-close-btn").click();
    await bob.evaluate(() => window.__ocMedia.restoreKeys());
    // The production fail-closed path may disconnect on EncryptionError. Make
    // the state determinate in both directions: if still connected, disconnect
    // and require the widget to actually hide; otherwise it is already out.
    // Either way the rejoin below is a fresh join, not a toggle-off.
    const bobWidget = bob.locator(".voice-widget");
    if (await bobWidget.evaluate((el) => el.classList.contains("visible"))) {
      await bob.locator(".voice-widget.visible button[aria-label='Disconnect']").click();
      await expect(bobWidget).not.toHaveClass(/visible/);
    }
    await joinVoice(bob);
    // A closed grid receives no remote video (P3-07), so the recovery control
    // must watch alice's camera first — the two control steps in the
    // signaling-loss test above do the same.
    await watchCamera(bob, 1);
    await expectDecodedMedia(bob, true);
  });
}
