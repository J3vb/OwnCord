import type { Page } from "@playwright/test";
import { expect } from "./fixtures";
import { mediaStats } from "../support/media";

/** Milliseconds from clicking voice-one to "Voice Connected" with remote audio decoding. */
export async function timeJoin(page: Page): Promise<number> {
  const connected = page.locator(".voice-widget.visible", { hasText: "Voice Connected" });
  const start = Date.now();
  await page.locator(".channel-item.voice", { hasText: "voice-one" }).click();
  await expect
    .poll(
      async () => {
        if ((await connected.count()) === 0) return false;
        const now = await mediaStats(page);
        return now.audioEnergy > 0 && now.audioSamples > 0;
      },
      { intervals: [50], timeout: 30_000 },
    )
    .toBe(true);
  return Date.now() - start;
}
