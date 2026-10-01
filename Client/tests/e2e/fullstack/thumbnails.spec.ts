/**
 * P4-08: server thumbnails and the client using them.
 *
 * Driven against the real Go server and the real built client over the real
 * HTTP/WS transport (no mocked IPC). An inline image row must show the server's
 * bounded preview (400x800 for a 1200x2400 original), while the lightbox opens
 * the full 1200x2400 file. The thumbnail must be kept beside the original on
 * disk, and a non-image must have no /thumb at all.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./fixtures";

/** A real baseline JPEG, 1200x2400, encoded by the page's own canvas so the
 *  binary is not checked in. */
async function bigJpeg(page: import("@playwright/test").Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 2400;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#c82828";
    ctx.fillRect(0, 0, 1200, 2400);
    ctx.fillStyle = "#2a7fff";
    ctx.fillRect(0, 0, 1200, 1200);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/jpeg", 0.9),
    );
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  return Buffer.from(bytes);
}

test("inline image shows the bounded thumbnail and the lightbox loads the full file", async ({
  alice,
  server,
}) => {
  const id = crypto.randomUUID().slice(0, 8);
  const jpeg = await bigJpeg(alice);
  expect(jpeg.length).toBeGreaterThan(1000);

  const composer = alice.locator("[data-testid='message-input']");
  await composer.locator("input[type='file']").setInputFiles({
    name: `big-${id}.jpg`,
    mimeType: "image/jpeg",
    buffer: jpeg,
  });
  await expect(composer.locator(".attachment-preview-item")).not.toHaveClass(/uploading/);
  await composer.locator("textarea").fill(`big-${id}`);
  await composer.locator("textarea").press("Enter");

  const row = alice.locator(".message", {
    has: alice.locator(".msg-text", { hasText: `big-${id}` }),
  });
  const inline = row.locator(".msg-image img");
  await expect(inline).toBeVisible();

  // The inline picture is the server's 800-box preview of the 1200x2400
  // original, i.e. 400x800 — not the original's 1200x2400.
  const natural = () =>
    inline.evaluate((el) => ({
      w: (el as HTMLImageElement).naturalWidth,
      h: (el as HTMLImageElement).naturalHeight,
    }));
  await expect.poll(natural).toEqual({ w: 400, h: 800 });

  // Opening the lightbox swaps in the full-size original.
  await inline.click();
  await expect(alice.locator(".image-lightbox")).toBeVisible();
  const light = alice.locator(".image-lightbox img");
  await expect
    .poll(() =>
      light.evaluate((el) => ({
        w: (el as HTMLImageElement).naturalWidth,
        h: (el as HTMLImageElement).naturalHeight,
      })),
    )
    .toEqual({ w: 1200, h: 2400 });

  // The preview was kept beside the original under upload.storage_dir/thumbs.
  const thumbsDir = join(server.directory, "data", "uploads", "thumbs");
  const kept = await readdir(thumbsDir);
  expect(kept.length).toBeGreaterThan(0);
});

test("a non-image file has no thumbnail route (404) and the row is a file chip", async ({
  alice,
  server,
}) => {
  const id = crypto.randomUUID().slice(0, 8);
  const composer = alice.locator("[data-testid='message-input']");
  await composer.locator("input[type='file']").setInputFiles({
    name: `notes-${id}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.from(`plain text, not an image ${id}`),
  });
  await expect(composer.locator(".attachment-preview-item")).not.toHaveClass(/uploading/);
  await composer.locator("textarea").fill(`file-${id}`);
  await composer.locator("textarea").press("Enter");

  await expect(alice.locator(".msg-file", { hasText: `notes-${id}.txt` })).toBeVisible();

  // The row carries the file; the server has no thumbnail for it. Resolve the
  // attachment id from the channel history and ask its /thumb directly.
  const channels = await server.api("/api/v1/channels/", undefined, server.owner!.token);
  const general = channels.find(
    (c: { name: string; type: string }) => c.name === "general" && c.type === "text",
  );
  const history = await server.api(
    `/api/v1/channels/${general.id}/messages`,
    undefined,
    server.owner!.token,
  );
  const message = history.messages.find((m: { content: string }) => m.content === `file-${id}`);
  const attachmentId = message.attachments[0].url.split("/").pop();
  const response = await fetch(`${server.origin}/api/v1/files/${attachmentId}/thumb`, {
    headers: { Authorization: `Bearer ${server.owner!.token}` },
  });
  expect(response.status).toBe(404);
});

test("erasing a user removes their kept thumbnail with the original", async ({
  alice,
  bob,
  server,
}) => {
  const id = crypto.randomUUID().slice(0, 8);
  const jpeg = await bigJpeg(bob);
  const composer = bob.locator("[data-testid='message-input']");
  await composer.locator("input[type='file']").setInputFiles({
    name: `bob-${id}.jpg`,
    mimeType: "image/jpeg",
    buffer: jpeg,
  });
  await expect(composer.locator(".attachment-preview-item")).not.toHaveClass(/uploading/);
  await composer.locator("textarea").fill(`bob-${id}`);
  await composer.locator("textarea").press("Enter");
  await expect(
    alice.locator(".message", { has: alice.locator(".msg-text", { hasText: `bob-${id}` }) }),
  ).toBeVisible();

  // Ask for the thumbnail so one is kept for bob's file.
  const channels = await server.api("/api/v1/channels/", undefined, server.owner!.token);
  const general = channels.find(
    (c: { name: string; type: string }) => c.name === "general" && c.type === "text",
  );
  const history = await server.api(
    `/api/v1/channels/${general.id}/messages`,
    undefined,
    server.owner!.token,
  );
  const message = history.messages.find((m: { content: string }) => m.content === `bob-${id}`);
  const attachmentId: string = message.attachments[0].url.split("/").pop();
  const preview = await fetch(`${server.origin}/api/v1/files/${attachmentId}/thumb`, {
    headers: { Authorization: `Bearer ${server.owner!.token}` },
  });
  expect(preview.status).toBe(200);

  const thumbsDir = join(server.directory, "data", "uploads", "thumbs");
  const before = (await readdir(thumbsDir)).filter((n) => n.startsWith(attachmentId));
  expect(before.length).toBeGreaterThan(0);

  const members = await server.api("/admin/api/users", undefined, server.owner!.token);
  const bobID = members.find((u: { username: string }) => u.username === "bob").id;
  const erased = await fetch(`${server.origin}/admin/api/users/${bobID}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${server.owner!.token}` },
  });
  expect(erased.status).toBe(204);

  const after = (await readdir(thumbsDir)).filter((n) => n.startsWith(attachmentId));
  expect(after).toEqual([]);
});
