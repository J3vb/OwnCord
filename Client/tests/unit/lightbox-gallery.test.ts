/**
 * Previous/next arrows between a message's images in the image viewer
 * (3A-10c): lightbox-gallery.ts, driven through openImageLightbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, saveMock, writeFileMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  saveMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: writeFileMock }));
vi.mock("@lib/net/httpProxy", () => ({
  ensureHttpProxy: () => Promise.resolve("http://127.0.0.1:9999"),
  stopHttpProxy: () => Promise.resolve(),
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@lib/icons", () => ({ createIcon: () => document.createElement("span") }));

import {
  clearAttachmentCaches,
  closeActiveLightbox,
  openImageLightbox,
  setServerHost,
  type LightboxGallery,
} from "../../src/features/messaging/content/attachments";
import { closeImageMenu } from "../../src/components/message-list/imageMenu";

const BASE = "https://myserver.local:8443/api/v1/files";
const items = ["a", "b", "c"].map((n) => ({
  url: `${BASE}/${n}`,
  filename: `${n}.png`,
  mime: "image/png",
}));

const okImage = {
  ok: true,
  headers: { get: () => "image/png" },
  arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
};
const fetchedPaths = (): string[] =>
  fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname);
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function open(index = 0, extra: Partial<LightboxGallery> = {}, list = items): void {
  const first = list[index]!;
  openImageLightbox(
    "blob:first",
    first.filename,
    { url: first.url },
    { items: list, index, ...extra },
  );
}
const ready = (): Promise<void> =>
  vi.waitFor(() => expect(document.querySelector(".image-lightbox-next")).not.toBeNull());
const key = (k: string, init: KeyboardEventInit = {}): void => {
  document.dispatchEvent(
    new KeyboardEvent(k === "" ? "keydown" : "keydown", {
      key: k,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
};
const counter = (): string | null | undefined =>
  document.querySelector(".image-lightbox-counter")?.textContent;
const overlay = (): HTMLElement => document.querySelector<HTMLElement>(".image-lightbox")!;
const lightboxImg = (): HTMLImageElement =>
  document.querySelector<HTMLImageElement>(".image-lightbox img")!;
const btn = (cls: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`.${cls}`)!;

let blobCount = 0;

beforeEach(() => {
  clearAttachmentCaches();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okImage);
  saveMock.mockReset();
  saveMock.mockResolvedValue(null);
  blobCount = 0;
  URL.createObjectURL = vi.fn(() => `blob:image-${++blobCount}`);
  URL.revokeObjectURL = vi.fn();
  setServerHost("myserver.local:8443");
});

afterEach(() => {
  closeImageMenu();
  closeActiveLightbox();
  document.body.replaceChildren();
});

describe("lightbox gallery", () => {
  it("shows arrows and a counter only when a message has 2+ images", async () => {
    open(0, {}, [items[0]!]);
    await flush();
    expect(document.querySelector(".image-lightbox")).not.toBeNull();
    expect(document.querySelector(".image-lightbox-prev")).toBeNull();
    expect(document.querySelector(".image-lightbox-next")).toBeNull();
    expect(document.querySelector(".image-lightbox-counter")).toBeNull();
    closeActiveLightbox();

    open(0);
    await ready();
    expect(btn("image-lightbox-prev").getAttribute("aria-label")).toBe("Previous image");
    expect(btn("image-lightbox-next").getAttribute("aria-label")).toBe("Next image");
    expect(counter()).toBe("1 of 3");
    expect(document.querySelector(".image-lightbox-counter")?.getAttribute("role")).toBe("status");
    // Close keeps the initial focus.
    expect(document.activeElement).toBe(btn("image-lightbox-close"));
  });

  it("stays open when a pan that starts on the image ends on the backdrop", async () => {
    open(0, {}, [items[0]!]);
    await flush();
    const overlay = document.querySelector<HTMLElement>(".image-lightbox")!;
    overlay.querySelector("img")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".image-lightbox")).not.toBeNull();
    overlay.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".image-lightbox")).toBeNull();
  });

  it("ArrowRight/ArrowLeft step and wrap, and the counter and aria-label follow", async () => {
    open(0);
    await ready();

    key("ArrowLeft");
    expect(counter()).toBe("3 of 3");
    expect(overlay().getAttribute("aria-label")).toBe("c.png");
    key("ArrowRight");
    expect(counter()).toBe("1 of 3");
    expect(overlay().getAttribute("aria-label")).toBe("a.png");
    key("ArrowRight");
    expect(counter()).toBe("2 of 3");
    expect(lightboxImg().alt).toBe("b.png");
    btn("image-lightbox-next").click();
    expect(counter()).toBe("3 of 3");
    expect(document.activeElement).toBe(btn("image-lightbox-next"));
    btn("image-lightbox-prev").click();
    expect(counter()).toBe("2 of 3");
  });

  it("a step resets zoom and ends a drag, and modifier+arrow or an open menu is ignored", async () => {
    open(0);
    await ready();
    const img = lightboxImg();
    img.click();
    expect(img.style.transform).toContain("scale(3)");
    img.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
    expect(overlay().classList.contains("dragging")).toBe(true);

    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      key("ArrowRight", mod);
    }
    expect(counter()).toBe("1 of 3");
    expect(img.style.transform).toContain("scale(3)");

    const menu = document.createElement("div");
    menu.className = "context-menu image-context-menu";
    document.body.appendChild(menu);
    key("ArrowRight");
    expect(counter()).toBe("1 of 3");
    menu.remove();

    key("ArrowRight");
    expect(counter()).toBe("2 of 3");
    expect(img.style.transform).toContain("scale(1)");
    expect(overlay().classList.contains("dragging")).toBe(false);
  });

  it("drops a late fetch for a previous step when stepping fast", async () => {
    let releaseB: (v: unknown) => void = () => undefined;
    fetchMock.mockImplementation((url: string) =>
      new URL(url).pathname.endsWith("/b")
        ? new Promise((r) => (releaseB = r))
        : Promise.resolve(okImage),
    );
    open(0);
    await ready();

    key("ArrowRight");
    key("ArrowRight");
    expect(counter()).toBe("3 of 3");
    await vi.waitFor(() => expect(lightboxImg().src).toMatch(/^blob:image-/));
    await flush();
    const shown = lightboxImg().src;

    releaseB(okImage);
    await flush();
    await flush();

    expect(lightboxImg().src).toBe(shown);
    expect(counter()).toBe("3 of 3");
    expect(overlay().getAttribute("aria-label")).toBe("c.png");
  });

  it("preloads the next image in the direction of travel only", async () => {
    open(2);
    await ready();
    await flush();
    fetchMock.mockClear();
    key("ArrowLeft");
    await flush();
    expect(fetchedPaths()).toContain("/api/v1/files/b");
    expect(fetchedPaths()).toContain("/api/v1/files/a");
    expect(fetchedPaths()).not.toContain("/api/v1/files/c");
  });

  it("Download after a step saves the current file", async () => {
    open(0);
    await ready();
    key("ArrowRight");

    document.querySelector<HTMLButtonElement>(".image-lightbox-toolbar button")!.click();
    await flush();

    expect(saveMock).toHaveBeenCalledWith({ defaultPath: "b.png" });
  });

  it("image menu Save after a step uses the current image", async () => {
    open(0);
    await ready();
    key("ArrowRight");
    key("ArrowRight");
    await flush();

    lightboxImg().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    await vi.waitFor(() =>
      expect(document.querySelector("[data-testid='image-menu-save']")).not.toBeNull(),
    );
    document.querySelector<HTMLElement>("[data-testid='image-menu-save']")!.click();
    await flush();

    expect(saveMock).toHaveBeenCalledWith({ defaultPath: "c.png" });
  });

  it.each([
    [
      "answers 404",
      () => Promise.resolve({ ok: false, status: 404, headers: { get: () => null } }),
    ],
    ["rejects", () => Promise.reject(new Error("offline"))],
  ])("a step whose image fetch %s drops the previous picture", async (_name, fail) => {
    fetchMock.mockImplementation((url: string) =>
      new URL(url).pathname.endsWith("/b") ? fail() : Promise.resolve(okImage),
    );
    open(0);
    await ready();
    await vi.waitFor(() => expect(lightboxImg().src).toMatch(/^blob:image-/));

    key("ArrowRight");
    await flush();
    await flush();

    expect(counter()).toBe("2 of 3");
    expect(lightboxImg().alt).toBe("b.png");
    expect(lightboxImg().hasAttribute("src")).toBe(false);
  });

  it("a slow first-image fetch finishing after a step does not overwrite the picture", async () => {
    let releaseA: (v: unknown) => void = () => undefined;
    fetchMock.mockImplementation((url: string) =>
      new URL(url).pathname.endsWith("/a")
        ? new Promise((r) => (releaseA = r))
        : Promise.resolve(okImage),
    );
    open(0);
    await ready();

    key("ArrowRight");
    await vi.waitFor(() => expect(lightboxImg().src).toMatch(/^blob:image-/));
    await flush();
    const shown = lightboxImg().src;

    releaseA(okImage);
    await flush();
    await flush();

    expect(lightboxImg().src).toBe(shown);
  });

  describe("with the clipboard and a decoder stubbed", () => {
    const drawImage = vi.fn();
    beforeEach(() => {
      drawImage.mockReset();
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
        drawImage,
      } as unknown as CanvasRenderingContext2D);
      vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) =>
        cb(new Blob(["png"], { type: "image/png" })),
      );
      Object.defineProperty(HTMLImageElement.prototype, "decode", {
        configurable: true,
        value: () => Promise.resolve(),
      });
      vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(8);
      vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(6);
      vi.stubGlobal(
        "ClipboardItem",
        class {
          constructor(readonly items: Record<string, Promise<Blob>>) {}
        },
      );
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { write: vi.fn().mockResolvedValue(undefined) },
      });
    });
    afterEach(() => {
      delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it("image menu Copy after a step fetches the current image", async () => {
      open(0);
      await ready();
      key("ArrowRight");
      await flush();
      await flush();
      // Drop the cache so Copy has to fetch, and the path shows which image.
      clearAttachmentCaches();
      fetchMock.mockClear();

      lightboxImg().dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
      );
      await vi.waitFor(() =>
        expect(document.querySelector("[data-testid='image-menu-copy']")).not.toBeNull(),
      );
      document.querySelector<HTMLElement>("[data-testid='image-menu-copy']")!.click();
      await vi.waitFor(() => expect(drawImage).toHaveBeenCalled());

      expect(fetchedPaths()).toEqual(["/api/v1/files/b"]);
    });
  });

  it("eviction recovery after a step reloads the current image", async () => {
    open(0);
    await ready();
    key("ArrowRight");
    await flush();
    await flush();
    clearAttachmentCaches();
    fetchMock.mockClear();

    lightboxImg().dispatchEvent(new Event("error"));
    await flush();
    await flush();

    expect(fetchedPaths()).toEqual(["/api/v1/files/b"]);
  });

  it("an eviction reload that finishes after a further step is dropped", async () => {
    open(0);
    await ready();
    key("ArrowRight");
    await flush();
    await flush();
    clearAttachmentCaches();
    let releaseB: (v: unknown) => void = () => undefined;
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) =>
      new URL(url).pathname.endsWith("/b")
        ? new Promise((r) => (releaseB = r))
        : Promise.resolve(okImage),
    );

    lightboxImg().dispatchEvent(new Event("error"));
    key("ArrowRight");
    await vi.waitFor(() => expect(lightboxImg().src).toMatch(/^blob:image-/));
    await flush();
    const shown = lightboxImg().src;
    expect(counter()).toBe("3 of 3");

    releaseB(okImage);
    await flush();
    await flush();

    expect(lightboxImg().src).toBe(shown);
  });

  it("a step closes an open image menu", async () => {
    open(0);
    await ready();
    await flush();
    lightboxImg().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }),
    );
    await vi.waitFor(() => expect(document.querySelector(".image-context-menu")).not.toBeNull());

    btn("image-lightbox-next").click();

    expect(document.querySelector(".image-context-menu")).toBeNull();
  });

  it("deleting the message closes the lightbox and unsubscribes", async () => {
    let onGone: () => void = () => undefined;
    const unsubscribe = vi.fn();
    const row = document.createElement("div");
    row.dataset["testid"] = "row";
    document.body.appendChild(row);
    open(0, {
      watch: (cb) => {
        onGone = cb;
        return unsubscribe;
      },
      row: () => row,
    });
    await ready();
    expect(unsubscribe).not.toHaveBeenCalled();

    onGone();

    expect(document.querySelector(".image-lightbox")).toBeNull();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(row);
    // Its document listeners are gone too.
    key("ArrowRight");
    expect(document.querySelector(".image-lightbox")).toBeNull();
  });

  it("releases the store subscription when the viewer closes another way", async () => {
    const unsubscribe = vi.fn();
    open(0, { watch: () => unsubscribe });
    await ready();

    closeActiveLightbox();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("closes at once when the message is already deleted", async () => {
    open(0, { isGone: () => true });
    await vi.waitFor(() => expect(document.querySelector(".image-lightbox")).toBeNull());
  });

  it("Tab cycles prev, next, Download, Close", async () => {
    open(0);
    await ready();
    const order = [
      btn("image-lightbox-prev"),
      btn("image-lightbox-next"),
      ...Array.from(document.querySelectorAll<HTMLButtonElement>(".image-lightbox-toolbar button")),
    ];
    expect(document.activeElement).toBe(order[order.length - 1]);
    const tab = (): void => key("Tab");
    tab();
    expect(document.activeElement).toBe(order[0]);
    tab();
    expect(document.activeElement).toBe(order[1]);
    tab();
    expect(document.activeElement).toBe(order[2]);
    tab();
    expect(document.activeElement).toBe(btn("image-lightbox-close"));
    expect(order[2]!.getAttribute("aria-label")).toBe("Download image");
  });
});
