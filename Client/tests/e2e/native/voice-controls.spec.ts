import { test, expect } from "../native-fixture-persistent";
import { ensureLoggedIn } from "./helpers";
import { setTimeout as delay } from "node:timers/promises";

// One complete journey avoids order-dependent tests sharing a live voice join.
// Full-stack tests separately require two-user decoded encrypted audio/video.
test("native voice connects, exposes controls, mutes, deafens and disconnects", async ({
  nativePage: page,
}) => {
  await ensureLoggedIn(page);
  const channel = page.locator(".channel-item.voice", { hasText: "voice-one" });
  await expect(channel.locator(".ch-icon [data-icon='volume-2']")).toBeVisible();
  await expect(channel.locator(".ch-name")).toHaveText("voice-one");
  await channel.click();
  const widget = page.locator(".voice-widget.visible");
  // connectAndSetup allows three attempts with 2s gaps. With this healthy
  // local fixture and Alice as key holder, livekit-client 2.22.1's 15s peer
  // timeout permits 3 * 15s + 2 * 2s = 49s of RTC recovery. Allow 11s for
  // local signaling/setup; 30s aborts the second attempt before its deadline.
  // This fixture bound does not cover arbitrary remote signaling/E2EE delays.
  await expect(widget).toContainText("Voice Connected", { timeout: 60_000 });
  await expect(widget.locator(".vw-channel")).toHaveText("voice-one");
  await expect(widget.getByRole("button", { name: "Camera", exact: true })).toBeVisible();
  await expect(widget.getByRole("button", { name: "Screenshare", exact: true })).toBeVisible();

  // B9-24: the transport-stats readout is a real button a keyboard user can
  // reach and operate, and the moderator-status live region exists from mount.
  const signal = widget.locator("[data-testid='vw-signal']");
  await expect(signal).toHaveAttribute("aria-expanded", "false");
  await signal.focus();
  await page.keyboard.press("Enter");
  await expect(widget.locator(".vw-stats")).toHaveClass(/visible/);
  await expect(signal).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Enter");
  await expect(widget.locator(".vw-stats")).not.toHaveClass(/visible/);
  await expect(widget.locator("[data-testid='vw-mod-status']")).toHaveAttribute("role", "status");

  const mute = widget.getByRole("button", { name: "Mute", exact: true });
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await expect(mute).toHaveClass(/active-ctrl/);
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await expect(mute).not.toHaveClass(/active-ctrl/);

  // The protocol permits two mute/deafen actions per second. This is input
  // pacing after the two mute actions, not a wait for UI/network readiness.
  await delay(1_000);
  const deafen = widget.getByRole("button", { name: "Deafen", exact: true });
  await expect(deafen).toHaveAttribute("aria-pressed", "false");
  await deafen.click();
  await expect(deafen).toHaveAttribute("aria-pressed", "true");
  await deafen.click();
  await expect(deafen).toHaveAttribute("aria-pressed", "false");
  await widget.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(widget).toBeHidden();
  await expect(page.locator(".voice-user-item", { hasText: "alice" })).toHaveCount(0);
});
