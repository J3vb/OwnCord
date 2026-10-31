/**
 * Wiring of a message's image attachments into the lightbox sequence
 * (3A-10c): renderers.ts hands renderAttachment the message's images and the
 * attachment's own index, and a store deletion closes the open viewer.
 */
import { describe, expect, it, vi } from "vitest";
import { loggerMock } from "../helpers/loggerMock";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@lib/net/httpProxy", () => ({
  ensureHttpProxy: () => Promise.resolve("http://127.0.0.1:9999"),
  stopHttpProxy: () => Promise.resolve(),
}));
vi.mock("@lib/logger", () => loggerMock());
vi.mock("@lib/icons", () => ({ createIcon: () => document.createElement("span") }));
vi.mock("@lib/prefs/mediaVisibility", () => ({ observeMedia: vi.fn() }));

import { renderMessage } from "../../src/components/message-list/renderers";
import { closeActiveLightbox } from "../../src/features/messaging/content/attachments";
import { messagesStore, type Message } from "../../src/stores/messages.store";
import {
  att,
  listOpts,
  makeAttachmentMessage,
  useImageRowEnv,
} from "../helpers/attachmentMessages";

const makeMessage = (overrides: Partial<Message> = {}): Message =>
  makeAttachmentMessage({
    attachments: [
      att("a", "a.png", "image/png"),
      att("v", "clip.mp4", "video/mp4"),
      att("b", "b.png", "image/png"),
      att("f", "notes.txt", "text/plain"),
      att("c", "c.png", "image/png"),
    ],
    ...overrides,
  });

const ac = new AbortController();
const counter = (): string | null | undefined =>
  document.querySelector(".image-lightbox-counter")?.textContent;

async function renderRow(msg: Message): Promise<HTMLImageElement[]> {
  const el = renderMessage(msg, false, [msg], listOpts, ac.signal);
  document.body.appendChild(el);
  let imgs: HTMLImageElement[] = [];
  const count = msg.attachments.filter((a) => a.mime.startsWith("image/")).length;
  await vi.waitFor(() => {
    imgs = [...el.querySelectorAll<HTMLImageElement>(".msg-image img")];
    expect(imgs.length).toBe(count);
  });
  return imgs;
}

useImageRowEnv(fetchMock);

describe("renderers lightbox sequence", () => {
  it("passes the message's images and the clicked index; videos and files are excluded", async () => {
    const msg = makeMessage();
    messagesStore.setState((prev) => ({ ...prev, messagesByChannel: new Map([[1, [msg]]]) }));
    const imgs = await renderRow(msg);

    imgs[1]!.click(); // b.png, the second image
    await vi.waitFor(() => expect(counter()).toBe("2 of 3"));
    expect(document.querySelector(".image-lightbox")?.getAttribute("aria-label")).toBe("b.png");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(counter()).toBe("3 of 3");
    expect(document.querySelector(".image-lightbox")?.getAttribute("aria-label")).toBe("c.png");
  });

  it("opens a lone image, and an unconfirmed row's images, with no arrows", async () => {
    const lone = makeMessage({ attachments: [att("a", "a.png", "image/png")] });
    const [only] = await renderRow(lone);
    only!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector(".image-lightbox")).not.toBeNull();
    expect(document.querySelector(".image-lightbox-next")).toBeNull();
    closeActiveLightbox();
    document.body.replaceChildren();

    const pending = makeMessage({ id: 0, status: "pending", correlationId: "c1" });
    const imgs = await renderRow(pending);
    imgs[0]!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector(".image-lightbox")).not.toBeNull();
    expect(document.querySelector(".image-lightbox-next")).toBeNull();
  });

  it("deleting the message in the store closes the open viewer", async () => {
    const msg = makeMessage();
    messagesStore.setState((prev) => ({ ...prev, messagesByChannel: new Map([[1, [msg]]]) }));
    const imgs = await renderRow(msg);
    imgs[0]!.click();
    await vi.waitFor(() => expect(counter()).toBe("1 of 3"));

    messagesStore.setState((prev) => ({
      ...prev,
      messagesByChannel: new Map([[1, [{ ...msg, deleted: true }]]]),
    }));
    messagesStore.flush();

    expect(document.querySelector(".image-lightbox")).toBeNull();
  });

  it("groups 2+ images into one ordered grid and leaves files outside", async () => {
    const msg = makeMessage({
      attachments: [
        att("a", "a.png", "image/png"),
        att("f", "notes.txt", "text/plain"),
        att("b", "b.png", "image/png"),
        att("c", "c.png", "image/png"),
      ],
    });
    messagesStore.setState((prev) => ({ ...prev, messagesByChannel: new Map([[1, [msg]]]) }));
    const imgs = await renderRow(msg);

    const grids = document.querySelectorAll(".msg-image-grid");
    expect(grids.length).toBe(1);
    const grid = grids[0]!;
    expect(grid.getAttribute("data-count")).toBe("3");
    expect([...grid.querySelectorAll("img")].map((i) => i.alt)).toEqual([
      "a.png",
      "b.png",
      "c.png",
    ]);
    expect(grid.children.length).toBe(3);
    const chip = document.querySelector(".msg-file");
    expect(chip).not.toBeNull();
    expect(grid.contains(chip)).toBe(false);

    imgs[1]!.click(); // tile 2 still opens the lightbox at index 1
    await vi.waitFor(() => expect(counter()).toBe("2 of 3"));
  });

  it("lays out a pending row's images as the grid before the id arrives", async () => {
    const msg = makeMessage({
      id: 0,
      attachments: [att("a", "a.png", "image/png"), att("b", "b.png", "image/png")],
    });
    await renderRow(msg);
    const grid = document.querySelector(".msg-image-grid");
    expect(grid?.getAttribute("data-count")).toBe("2");
    expect(grid?.querySelectorAll("img").length).toBe(2);
  });

  it("renders a single image without a grid wrapper", async () => {
    const msg = makeMessage({ attachments: [att("a", "a.png", "image/png")] });
    await renderRow(msg);
    expect(document.querySelector(".msg-image-grid")).toBeNull();
    expect(document.querySelectorAll(".msg-image").length).toBe(1);
  });
});
