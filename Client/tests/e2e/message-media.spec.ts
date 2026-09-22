/**
 * Mocked E2E: message media (audit batch N9, gaps #11–12) — the inline-image
 * lightbox (zoom, pan, close), the YouTube embed card, the Open Graph link
 * preview, and the GIF picker including its `GIF_DISABLED` degradation.
 *
 * The mocked suite has no external network, so every external fetch the app
 * makes (link previews, oEmbed titles, and every external image) goes through
 * the external-content broker (B7-16), which the Tauri mock stubs per test
 * (`externalContent`). Assertions read rendered UI and outgoing IPC/WS traffic
 * (`window.__invokeLog`) — never the stub's own bookkeeping — so breaking the
 * feature (removing the handler, the broker call, the render) turns a test red.
 */
import type { Page } from "@playwright/test";
import zlib from "node:zlib";
import { test, expect } from "./fixtures";
import {
  buildTauriMockScript,
  MOCK_LOGIN_RESPONSE,
  MOCK_PINNED_MESSAGES,
  navigateToMainPage,
  waitForWsReady,
} from "./helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IMAGE_URL = "https://images.example.com/cat.png";
const YOUTUBE_ID = "dQw4w9WgXcQ";
const YOUTUBE_URL = `https://www.youtube.com/watch?v=${YOUTUBE_ID}`;
const YOUTUBE_OEMBED_URL = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${YOUTUBE_ID}&format=json`;
const YOUTUBE_THUMB_URL = `https://img.youtube.com/vi/${YOUTUBE_ID}/mqdefault.jpg`;
const LINK_URL = "https://example.com/article";
const LINK_IMAGE_HANDLE = "preview-img-handle";
const GIF_TINY_URL = "https://cdn.klipy.com/tiny/1.gif";
const GIF_FULL_URL = "https://cdn.klipy.com/full/1.gif";

/** A real raster image the broker can hand back as a same-origin blob. Built
 *  here (not a fixture file) so the lightbox tests can size it: a tiny image
 *  cannot be panned inside the overlay without the pointer leaving it. */
function makePng(width: number, height: number): number[] {
  const crc = (buf: Buffer): number => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const off = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      raw[off + 1 + x * 3] = (x * 3) & 255;
      raw[off + 2 + x * 3] = (y * 3) & 255;
      raw[off + 3 + x * 3] = 128;
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return Array.from(png);
}

/** 8×8 thumbnails are enough for embeds; full-size images need room to pan. */
const PNG_BYTES = makePng(8, 8);
const LIGHTBOX_PNG_BYTES = makePng(300, 200);

function mediaMessage(id: number, content: string) {
  return {
    id,
    channel_id: 1,
    user: { id: 2, username: "otheruser", avatar: "" },
    content,
    timestamp: "2026-03-15T10:00:00Z",
    edited_at: null,
    attachments: [],
    reactions: [],
    reply_to: null,
    pinned: false,
    deleted: false,
  };
}

/** Messages whose content is an image URL, a YouTube URL and a generic URL. */
const MOCK_MEDIA_MESSAGES = {
  messages: [
    mediaMessage(201, IMAGE_URL),
    mediaMessage(202, YOUTUBE_URL),
    mediaMessage(203, LINK_URL),
  ],
  has_more: false,
};

interface ExternalContentOption {
  readonly preview?: Record<string, Record<string, unknown> | string>;
  readonly image?: Record<string, number[] | string>;
}

async function mockSession(page: Page, externalContent: ExternalContentOption): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({
      httpRoutes: [
        { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
        { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
        { pattern: "/messages", status: 200, body: MOCK_MEDIA_MESSAGES },
        { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
      ],
      simulateWsFlow: true,
      externalContent,
    }),
  );
}

/** Every preview/image the app asked the broker for, with its args. */
async function brokerCalls(page: Page) {
  return page.evaluate(() => {
    const log = (
      window as unknown as {
        __invokeLog: Array<{ cmd: string; args?: Record<string, unknown> }>;
      }
    ).__invokeLog;
    return log
      .filter((e) => e.cmd === "external_preview" || e.cmd === "external_image")
      .map((e) => ({ cmd: e.cmd, args: e.args ?? {} }));
  });
}

async function sentFrames(
  page: Page,
): Promise<Array<{ type: string; payload?: Record<string, unknown> }>> {
  return page.evaluate(() => {
    const log = (
      window as unknown as { __invokeLog: Array<{ cmd: string; args?: { message?: string } }> }
    ).__invokeLog;
    const frames: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    for (const entry of log) {
      if (entry.cmd !== "ws_send") continue;
      try {
        frames.push(JSON.parse(entry.args?.message ?? "{}"));
      } catch {
        // Not a JSON client frame; skip.
      }
    }
    return frames;
  });
}

async function bootMedia(page: Page, externalContent: ExternalContentOption): Promise<void> {
  await mockSession(page, externalContent);
  await page.goto("/");
  await navigateToMainPage(page);
  await waitForWsReady(page);
}

// ---------------------------------------------------------------------------
// Image lightbox
// ---------------------------------------------------------------------------

const lightboxImg = (page: Page) => page.locator(".image-lightbox img");

async function currentTransform(page: Page): Promise<{ scale: number; x: number; y: number }> {
  return lightboxImg(page).evaluate((el) => {
    const parsed = /scale\(([-\d.]+)\)/.exec((el as HTMLElement).style.transform);
    const translate = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(
      (el as HTMLElement).style.transform,
    );
    return {
      scale: parsed ? Number(parsed[1]) : 1,
      x: translate ? Number(translate[1]) : 0,
      y: translate ? Number(translate[2]) : 0,
    };
  });
}

test.describe("Image lightbox", () => {
  test("a direct image URL is fetched through the broker and opens the lightbox on click", async ({
    page,
  }) => {
    await bootMedia(page, { image: { [`url:${IMAGE_URL}`]: LIGHTBOX_PNG_BYTES } });

    const inlineImg = page.locator("[data-testid='message-201'] .msg-image img");
    await expect(inlineImg).toHaveAttribute("src", /^blob:/, { timeout: 5_000 });
    await expect(page.locator(".image-lightbox")).toBeHidden();

    await inlineImg.click();

    // The overlay shows the same broker-fetched bytes, and the broker was asked
    // for the external URL rather than the webview loading it directly.
    await expect(page.locator(".image-lightbox")).toBeVisible();
    await expect(lightboxImg(page)).toHaveAttribute("src", /^blob:/);
    const calls = await brokerCalls(page);
    expect(
      calls.some((c) => c.cmd === "external_image" && c.args.url === IMAGE_URL),
      "the inline image must be fetched through the external-content broker",
    ).toBe(true);
  });

  test("clicking toggles zoom to 3x and back, and the close button dismisses the overlay", async ({
    page,
  }) => {
    await bootMedia(page, { image: { [`url:${IMAGE_URL}`]: LIGHTBOX_PNG_BYTES } });
    const inlineImg = page.locator("[data-testid='message-201'] .msg-image img");
    await expect(inlineImg).toHaveAttribute("src", /^blob:/, { timeout: 5_000 });
    await inlineImg.click();
    await expect(page.locator(".image-lightbox")).toBeVisible();

    await lightboxImg(page).click();
    await expect.poll(() => currentTransform(page)).toMatchObject({ scale: 3 });

    // A second click (no drag) resets the zoom.
    await lightboxImg(page).click();
    await expect.poll(() => currentTransform(page)).toMatchObject({ scale: 1, x: 0, y: 0 });

    await page.locator(".image-lightbox-close").click();
    await expect(page.locator(".image-lightbox")).toBeHidden();
  });

  test("wheel zoom scales and dragging while zoomed pans the image", async ({ page }) => {
    await bootMedia(page, { image: { [`url:${IMAGE_URL}`]: LIGHTBOX_PNG_BYTES } });
    const inlineImg = page.locator("[data-testid='message-201'] .msg-image img");
    await expect(inlineImg).toHaveAttribute("src", /^blob:/, { timeout: 5_000 });
    await inlineImg.click();
    await expect(page.locator(".image-lightbox")).toBeVisible();

    const box = (await lightboxImg(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -120);

    const zoomed = await currentTransform(page);
    expect(zoomed.scale).toBeGreaterThan(1.1);

    // Zoomed past the pan threshold, a drag translates the image.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 5 });
    await page.mouse.up();

    const panned = await currentTransform(page);
    expect(panned.x).not.toBe(zoomed.x);
    expect(panned.y).not.toBe(zoomed.y);

    await page.keyboard.press("Escape");
    await expect(page.locator(".image-lightbox")).toBeHidden();
  });

  test("clicking the backdrop outside the image closes the lightbox", async ({ page }) => {
    await bootMedia(page, { image: { [`url:${IMAGE_URL}`]: LIGHTBOX_PNG_BYTES } });
    const inlineImg = page.locator("[data-testid='message-201'] .msg-image img");
    await expect(inlineImg).toHaveAttribute("src", /^blob:/, { timeout: 5_000 });
    await inlineImg.click();
    await expect(page.locator(".image-lightbox")).toBeVisible();

    await page.locator(".image-lightbox").click({ position: { x: 5, y: 5 } });
    await expect(page.locator(".image-lightbox")).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// YouTube embed
// ---------------------------------------------------------------------------

test.describe("YouTube embed", () => {
  test("renders the player card with the broker-resolved title and thumbnail, then plays on click", async ({
    page,
  }) => {
    await bootMedia(page, {
      preview: { [YOUTUBE_OEMBED_URL]: { title: "Rick Astley - Never Gonna Give You Up" } },
      image: { [`url:${YOUTUBE_THUMB_URL}`]: PNG_BYTES },
    });

    const embed = page.locator("[data-testid='message-202'] .msg-embed-youtube");
    await expect(embed).toBeVisible();

    // The host label and the oEmbed title both come from the app's render path.
    await expect(embed.locator(".msg-embed-host")).toHaveText("YouTube");
    await expect(embed.locator(".msg-embed-yt-title")).toHaveText(
      "Rick Astley - Never Gonna Give You Up",
      { timeout: 5_000 },
    );
    await expect(embed.locator(".msg-embed-yt-title")).toHaveAttribute("href", YOUTUBE_URL);

    // The thumbnail is broker-fetched, and the broker was asked for the oEmbed doc.
    await expect(embed.locator(".msg-embed-thumb")).toHaveAttribute("src", /^blob:/, {
      timeout: 5_000,
    });
    const calls = await brokerCalls(page);
    expect(
      calls.some((c) => c.cmd === "external_preview" && c.args.url === YOUTUBE_OEMBED_URL),
      "the oEmbed title must be resolved through the broker",
    ).toBe(true);

    await expect(embed.locator(".msg-embed-iframe")).toHaveCount(0);
    await embed.locator(".msg-embed-yt-player").click();
    await expect(embed.locator(".msg-embed-iframe")).toHaveAttribute(
      "src",
      `https://www.youtube.com/embed/${YOUTUBE_ID}?autoplay=1`,
    );
  });
});

// ---------------------------------------------------------------------------
// Link preview
// ---------------------------------------------------------------------------

test.describe("Link preview", () => {
  test("renders the OG title, site, description and broker image from the preview", async ({
    page,
  }) => {
    await bootMedia(page, {
      preview: {
        [LINK_URL]: {
          title: "Example Article",
          description: "A short summary of the linked page.",
          siteName: "Example",
          image: LINK_IMAGE_HANDLE,
        },
      },
      image: { [`handle:${LINK_IMAGE_HANDLE}`]: PNG_BYTES },
    });

    const card = page.locator("[data-testid='message-203'] .msg-embed-link");
    await expect(card).toBeVisible();
    await expect(card.locator(".msg-embed-link-title")).toHaveText("Example Article", {
      timeout: 5_000,
    });
    await expect(card.locator(".msg-embed-link-title")).toHaveAttribute("href", LINK_URL);
    await expect(card.locator(".msg-embed-host")).toHaveText("Example");
    await expect(card.locator(".msg-embed-link-desc")).toHaveText(
      "A short summary of the linked page.",
    );

    // The preview image arrives as broker bytes fetched by its opaque handle,
    // never as an og:image URL the webview loads itself.
    await expect(card.locator(".msg-embed-link-img")).toHaveAttribute("src", /^blob:/, {
      timeout: 5_000,
    });
    const calls = await brokerCalls(page);
    expect(
      calls.some((c) => c.cmd === "external_preview" && c.args.url === LINK_URL),
      "the OG metadata must be fetched through the broker",
    ).toBe(true);
    expect(
      calls.some((c) => c.cmd === "external_image" && c.args.handle === LINK_IMAGE_HANDLE),
      "the preview image must be fetched by its broker handle",
    ).toBe(true);
  });

  test("falls back to the bare host when the broker refuses the preview", async ({ page }) => {
    // No stub for LINK_URL: the broker refuses it as "unavailable".
    await bootMedia(page, {});

    const card = page.locator("[data-testid='message-203'] .msg-embed-link");
    await expect(card).toBeVisible();
    await expect(card.locator(".msg-embed-link-title")).toHaveText("example.com");
    await expect(card.locator(".msg-embed-link-image")).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// GIF picker
// ---------------------------------------------------------------------------

function gifResult(id: string, title: string, slug = id) {
  return {
    id,
    title,
    media_formats: {
      tinygif: { url: `https://cdn.klipy.com/tiny/${slug}.gif` },
      gif: { url: `https://cdn.klipy.com/full/${slug}.gif` },
    },
  };
}

const GIF_TINY_TRENDING = gifResult("1", "Funny cat");

function gifRoutes(trendingBody: unknown, trendingStatus = 200) {
  return [
    { pattern: "/api/v1/health", status: 200, body: { status: "ok", version: "1.0.0" } },
    { pattern: "/api/v1/auth/login", status: 200, body: MOCK_LOGIN_RESPONSE },
    { pattern: "/messages", status: 200, body: MOCK_MEDIA_MESSAGES },
    { pattern: "/pins", status: 200, body: MOCK_PINNED_MESSAGES },
    { pattern: "/api/v1/gif/trending", status: trendingStatus, body: trendingBody },
  ];
}

async function bootGif(
  page: Page,
  httpRoutes: Array<{ pattern: string; status: number; body: unknown }>,
  externalContent: ExternalContentOption = {},
): Promise<void> {
  await page.addInitScript(
    buildTauriMockScript({ httpRoutes, simulateWsFlow: true, externalContent }),
  );
  await page.goto("/");
  await navigateToMainPage(page);
  await waitForWsReady(page);
  await page.locator(".gif-btn").click();
  await expect(page.locator(".gif-picker")).toBeVisible();
}

test.describe("GIF picker", () => {
  test("opens trending from the server's GIF proxy and sends the selected GIF", async ({
    page,
  }) => {
    await bootGif(page, gifRoutes({ results: [GIF_TINY_TRENDING, gifResult("2", "Happy dog")] }), {
      image: { [`url:${GIF_TINY_URL}`]: PNG_BYTES },
    });

    const items = page.locator(".gp-item");
    await expect(items).toHaveCount(2);
    await expect(items.first()).toHaveAttribute("aria-label", "Funny cat");
    await expect(items.first().locator(".gp-img")).toHaveAttribute("src", /^blob:/, {
      timeout: 5_000,
    });

    await items.first().click();

    // Selecting a GIF sends its full-size URL directly (not through the draft).
    await expect
      .poll(async () =>
        (await sentFrames(page)).some(
          (f) => f.type === "chat_send" && f.payload?.content === GIF_FULL_URL,
        ),
      )
      .toBe(true);
    await expect(page.locator(".gif-picker")).toHaveCount(0);
  });

  test("a debounced search replaces trending with the server's search results", async ({
    page,
  }) => {
    await bootGif(page, [
      ...gifRoutes({ results: [GIF_TINY_TRENDING, gifResult("2", "Happy dog")] }),
      {
        pattern: "/api/v1/gif/search",
        status: 200,
        body: { results: [gifResult("3", "Search result", "3")] },
      },
    ]);

    await expect(page.locator(".gp-item")).toHaveCount(2);

    await page.locator(".gp-search").fill("party");
    await expect(page.locator(".gp-item")).toHaveCount(1);
    await expect(page.locator(".gp-item").first()).toHaveAttribute("aria-label", "Search result");

    const httpCalls = await page.evaluate(() =>
      (
        window as unknown as {
          __invokeLog: Array<{ cmd: string; args?: { clientConfig?: { url?: string } } }>;
        }
      ).__invokeLog
        .filter((e) => e.cmd === "plugin:http|fetch")
        .map((e) => e.args?.clientConfig?.url ?? ""),
    );
    expect(
      httpCalls.some((url) => url.includes("/api/v1/gif/search") && url.includes("q=party")),
    ).toBe(true);
  });

  test("GIF_DISABLED degrades the picker and disables the GIF button", async ({ page }) => {
    await bootGif(
      page,
      gifRoutes({ error: "GIF_DISABLED", message: "GIF provider not configured" }, 503),
    );

    // The picker states the reason instead of looking broken, and the search
    // box is no longer usable.
    await expect(page.locator(".gif-picker")).toHaveClass(/gp-unavailable/);
    await expect(page.locator(".gp-search")).toBeDisabled();
    await expect(page.locator(".gp-empty")).toHaveText("GIFs are not enabled on this server");

    // The affordance itself is disabled so the user is not offered the feature.
    await expect(page.locator(".gif-btn")).toBeDisabled();
    await expect(page.locator(".gif-btn")).toHaveAttribute(
      "title",
      "GIFs are not enabled on this server",
    );
  });

  test("an empty trending response shows the empty state", async ({ page }) => {
    await bootGif(page, gifRoutes({ results: [] }));

    await expect(page.locator(".gp-item")).toHaveCount(0);
    await expect(page.locator(".gp-empty")).toHaveText("No GIFs found");
  });
});
