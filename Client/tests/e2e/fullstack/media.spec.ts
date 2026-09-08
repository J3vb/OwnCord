import { test, expect } from "./fixtures";
import { expectDecodedMedia, joinVoice, mediaStats } from "../support/media";

test.use({ media: true });
test.setTimeout(180_000);

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

  // The application server intentionally removes voice membership when
  // its authenticated socket disconnects. Require cleanup, then a fresh
  // authorized join and key exchange after application reconnection.
  await aliceTransport.offline();
  await expect(alice.locator(".reconnecting-banner")).toBeVisible();
  aliceTransport.online();
  await expect(alice.locator(".reconnecting-banner")).not.toBeVisible();
  await expect(alice.locator(".voice-widget")).not.toHaveClass(/visible/);
  await expect.poll(async () => (await mediaStats(alice)).liveCapture).toBe(0);
  await joinVoice(alice);
  await expectDecodedMedia(alice);
  await alice.locator(".voice-widget button[aria-label='Camera']").click();
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

test("the real stats poller expands connection details when RTT degrades", async ({
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
    await bob.evaluate(() => window.__ocMedia.restoreKeys());
    // The production fail-closed path may disconnect on EncryptionError.
    // Rejoin with valid keys and require real decoded media again.
    const disconnect = bob.locator(".voice-widget.visible button[aria-label='Disconnect']");
    if (await disconnect.isVisible()) await disconnect.click();
    await joinVoice(bob);
    await expectDecodedMedia(bob, true);
  });
}
