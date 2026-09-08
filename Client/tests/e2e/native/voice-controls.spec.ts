import { test, expect } from "../native-fixture-persistent";
import { ensureLoggedIn } from "./helpers";

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
  await expect(widget).toContainText("Voice Connected", { timeout: 30_000 });
  await expect(widget.locator(".vw-channel")).toHaveText("voice-one");
  await expect(widget.getByRole("button", { name: "Camera", exact: true })).toBeVisible();
  await expect(widget.getByRole("button", { name: "Screenshare", exact: true })).toBeVisible();

  const mute = widget.getByRole("button", { name: "Mute", exact: true });
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await expect(mute).toHaveClass(/active-ctrl/);
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await expect(mute).not.toHaveClass(/active-ctrl/);

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
