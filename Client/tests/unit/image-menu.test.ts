/**
 * The right-click menu on chat images and the lightbox (image-menu.ts):
 * Copy Image, Copy Link, Open Link, Save Image.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const { openUrlMock, saveMock, writeFileMock, showToastMock } = vi.hoisted(() => ({
  openUrlMock: vi.fn(),
  saveMock: vi.fn(),
  writeFileMock: vi.fn(),
  showToastMock: vi.fn(),
}));

// The opener is the `open_external_url` command; `openUrlMock` records its URL.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: { url: string }) => {
    if (command !== "open_external_url") throw new Error(`unexpected invoke ${command}`);
    return openUrlMock(args!.url);
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: writeFileMock }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@lib/icons", () => ({ createIcon: () => document.createElement("span") }));
vi.mock("@lib/ui/toast", () => ({
  showToast: showToastMock,
  initToast: vi.fn(),
  teardownToast: vi.fn(),
}));

import {
  closeImageMenu,
  imageFilename,
  saveImageBytes,
} from "../../src/components/message-list/imageMenu";
import {
  bindImageMenu,
  closeActiveLightbox,
  openImageLightbox,
  setServerHost,
} from "../../src/features/messaging/content/attachments";
import { desktop } from "../../src/platform/desktop";
import {
  resetExternalConsent,
  setExternalConsentChoice,
} from "../../src/features/content-consent/external";
import { cascadedDeclaration } from "../helpers/app-css";

const LINK = "https://static.klipy.com/gifs/cat.gif";

function loadedImage(): HTMLImageElement {
  const img = document.createElement("img");
  img.src = "blob:http://localhost/abc";
  Object.defineProperty(img, "naturalWidth", { value: 4 });
  Object.defineProperty(img, "naturalHeight", { value: 3 });
  document.body.appendChild(img);
  return img;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Right-click `el` and let the lazily loaded menu module open. */
async function rightClick(el: Element, x = 40, y = 50): Promise<MouseEvent> {
  const e = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  el.dispatchEvent(e);
  await flush();
  return e;
}

function menuLabels(): string[] {
  return Array.from(document.querySelectorAll(".image-context-menu [role='menuitem']")).map(
    (el) => el.textContent ?? "",
  );
}

function clickItem(testId: string): void {
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click();
}

const clipboard = { write: vi.fn(), writeText: vi.fn() };

beforeEach(() => {
  vi.stubGlobal("navigator", { ...navigator, clipboard });
  clipboard.write.mockResolvedValue(undefined);
  clipboard.writeText.mockResolvedValue(undefined);
  openUrlMock.mockResolvedValue(undefined);
});

afterEach(() => {
  closeImageMenu();
  closeActiveLightbox();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("bindImageMenu", () => {
  it("offers Copy Image, Copy Link, Open Link and Save Image for a linked image", async () => {
    const img = loadedImage();
    bindImageMenu({ img, link: LINK, save: vi.fn() });

    const e = await rightClick(img);

    expect(e.defaultPrevented).toBe(true);
    expect(menuLabels()).toEqual(["Copy Image", "Copy Link", "Open Link", "Save Image"]);
  });

  it("leaves the link rows out for a server attachment", async () => {
    const img = loadedImage();
    bindImageMenu({ img, link: null, save: vi.fn() });

    await rightClick(img);

    expect(menuLabels()).toEqual(["Copy Image", "Save Image"]);
  });

  it("opens nothing on an image that has not loaded", async () => {
    const img = document.createElement("img");
    img.hidden = true;
    document.body.appendChild(img);
    bindImageMenu({ img, link: LINK, save: vi.fn() });

    await rightClick(img);

    expect(document.querySelector(".image-context-menu")).toBeNull();
  });

  it("keeps one menu open across repeated right-clicks", async () => {
    const img = loadedImage();
    bindImageMenu({ img, link: LINK, save: vi.fn() });

    await rightClick(img);
    await rightClick(img);

    expect(document.querySelectorAll(".image-context-menu")).toHaveLength(1);
  });

  it("Copy Link copies the image's address and confirms", async () => {
    const img = loadedImage();
    bindImageMenu({ img, link: LINK, save: vi.fn() });
    await rightClick(img);

    clickItem("image-menu-copy-link");
    await flush();

    expect(clipboard.writeText).toHaveBeenCalledWith(LINK);
    expect(showToastMock).toHaveBeenCalledWith("Link copied", "success");
    expect(document.querySelector(".image-context-menu")).toBeNull();
  });

  it("Open Link opens the address in the default browser", async () => {
    const img = loadedImage();
    bindImageMenu({ img, link: LINK, save: vi.fn() });
    await rightClick(img);

    clickItem("image-menu-open-link");
    await flush();

    expect(openUrlMock).toHaveBeenCalledWith(LINK);
  });

  it("Open Link reports a failed open", async () => {
    openUrlMock.mockRejectedValue(new Error("denied"));
    const img = loadedImage();
    bindImageMenu({ img, link: LINK, save: vi.fn() });
    await rightClick(img);

    clickItem("image-menu-open-link");
    await flush();

    expect(showToastMock).toHaveBeenCalledWith("Couldn't open the link", "error");
  });

  it("Save Image runs the target's save", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const img = loadedImage();
    bindImageMenu({ img, link: null, save });
    await rightClick(img);

    clickItem("image-menu-save");

    expect(save).toHaveBeenCalledOnce();
  });

  it("Copy Image puts a PNG of the image on the clipboard", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) => cb(png));
    class FakeClipboardItem {
      constructor(readonly items: Record<string, Promise<Blob>>) {}
    }
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    const img = loadedImage();
    bindImageMenu({ img, link: null, save: vi.fn() });
    await rightClick(img);

    clickItem("image-menu-copy");
    await flush();

    expect(drawImage).toHaveBeenCalledWith(img, 0, 0);
    const [items] = clipboard.write.mock.calls[0] as [FakeClipboardItem[]];
    await expect(items[0]!.items["image/png"]).resolves.toBe(png);
    expect(showToastMock).toHaveBeenCalledWith("Image copied", "success");
  });

  it("Copy Image copies the full image when the row shows a preview", async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) =>
      cb(new Blob(["png"], { type: "image/png" })),
    );
    // jsdom has no HTMLImageElement.decode.
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      value: () => Promise.resolve(),
    });
    onTestFinished(() => {
      delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
    });
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(8);
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(6);
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly items: Record<string, Promise<Blob>>) {}
      },
    );
    const img = loadedImage();
    const full = vi.fn().mockResolvedValue("blob:http://localhost/full");
    bindImageMenu({ img, link: null, full, save: vi.fn() });
    await rightClick(img);

    clickItem("image-menu-copy");
    await vi.waitFor(() => expect(showToastMock).toHaveBeenCalledWith("Image copied", "success"));

    expect(full).toHaveBeenCalledOnce();
    const drawn = drawImage.mock.calls[0]![0] as HTMLImageElement;
    expect(drawn).not.toBe(img);
    expect(drawn.src).toBe("blob:http://localhost/full");
  });

  it("Copy Image reports a full image that could not be fetched", async () => {
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly items: Record<string, Promise<Blob>>) {}
      },
    );
    clipboard.write.mockImplementation(
      async ([item]: [{ items: Record<string, Promise<Blob>> }]) => {
        await item.items["image/png"];
      },
    );
    const img = loadedImage();
    bindImageMenu({ img, link: null, full: () => Promise.resolve(null), save: vi.fn() });
    await rightClick(img);

    clickItem("image-menu-copy");
    await vi.waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith("Couldn't copy the image", "error"),
    );
  });

  it("Copy Image reports a webview without image clipboard support", async () => {
    vi.stubGlobal("ClipboardItem", undefined);
    const img = loadedImage();
    bindImageMenu({ img, link: null, save: vi.fn() });
    await rightClick(img);

    clickItem("image-menu-copy");
    await flush();

    expect(showToastMock).toHaveBeenCalledWith("Couldn't copy the image", "error");
  });

  it("closes with its owner's signal", async () => {
    const owner = new AbortController();
    const img = loadedImage();
    bindImageMenu({ img, link: LINK, save: vi.fn() }, owner.signal);
    await rightClick(img);

    owner.abort();

    expect(document.querySelector(".image-context-menu")).toBeNull();
  });
});

describe("imageFilename", () => {
  it("keeps the URL's own image filename", () => {
    expect(imageFilename(LINK, "image/gif")).toBe("cat.gif");
    expect(imageFilename("https://x.test/a/My%20Pic.JPEG?s=1", "image/jpeg")).toBe("My Pic.JPEG");
  });

  it("names an extensionless image from its type", () => {
    expect(imageFilename("https://x.test/render", "image/jpeg")).toBe("image.jpg");
    expect(imageFilename("https://x.test/render", "image/svg+xml")).toBe("image.svg");
    expect(imageFilename("", "")).toBe("image.png");
  });
});

describe("saveImageBytes", () => {
  it("writes the image's bytes where the user chose", async () => {
    const blob = new Blob(["gif"], { type: "image/gif" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ blob: () => Promise.resolve(blob) }));
    saveMock.mockResolvedValue("/home/u/cat.gif");

    await saveImageBytes("blob:http://localhost/abc", LINK);

    expect(saveMock).toHaveBeenCalledWith({ defaultPath: "cat.gif" });
    expect(writeFileMock).toHaveBeenCalledWith("/home/u/cat.gif", expect.any(Uint8Array));
  });

  it("writes nothing when the user cancels", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ blob: () => Promise.resolve(new Blob(["x"])) }),
    );
    saveMock.mockResolvedValue(null);

    await saveImageBytes("blob:http://localhost/abc", LINK);

    expect(writeFileMock).not.toHaveBeenCalled();
  });
});

describe("lightbox image menu", () => {
  it("opens above the lightbox", () => {
    const zIndex = (selector: string): number => {
      const v = cascadedDeclaration(selector, "z-index")?.value.value as
        { type?: string; value?: number } | undefined;
      return v?.type === "integer" ? v.value! : Number.NaN;
    };
    expect(zIndex(".context-menu.image-context-menu")).toBeGreaterThan(zIndex(".image-lightbox"));
  });

  it("Escape in the menu closes the menu, not the lightbox", async () => {
    openImageLightbox("blob:http://localhost/abc", "cat", { url: LINK });
    await rightClick(document.querySelector(".image-lightbox img")!);
    const item = document.querySelector<HTMLElement>("[data-testid='image-menu-copy']")!;

    item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(document.querySelector(".image-context-menu")).toBeNull();
    expect(document.querySelector(".image-lightbox")).not.toBeNull();
  });

  it("opens over the lightbox with the external image's link, and closes with it", async () => {
    setServerHost("chat.example.com");
    openImageLightbox("blob:http://localhost/abc", "cat", { url: LINK });
    const img = document.querySelector<HTMLImageElement>(".image-lightbox img")!;

    await rightClick(img);
    expect(menuLabels()).toEqual(["Copy Image", "Copy Link", "Open Link", "Save Image"]);

    closeActiveLightbox();
    expect(document.querySelector(".image-context-menu")).toBeNull();
  });

  it("offers no link for a server attachment in the lightbox", async () => {
    setServerHost("chat.example.com");
    openImageLightbox("blob:http://localhost/abc", "photo.png", {
      url: "https://chat.example.com/api/v1/files/abc",
    });
    const img = document.querySelector<HTMLImageElement>(".image-lightbox img")!;

    await rightClick(img);

    expect(menuLabels()).toEqual(["Copy Image", "Save Image"]);
  });

  it("the Menu key opens the image menu from the lightbox's close button", async () => {
    openImageLightbox("blob:http://localhost/abc", "cat", { url: LINK });

    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }),
    );
    await flush();

    expect(menuLabels()).toEqual(["Copy Image", "Copy Link", "Open Link", "Save Image"]);
  });

  it("a right-button press does not start a pan on a zoomed image", () => {
    openImageLightbox("blob:http://localhost/abc", "cat", { url: LINK });
    const overlay = document.querySelector(".image-lightbox")!;
    const img = overlay.querySelector("img")!;
    img.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "+" }));

    img.dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true, cancelable: true }));

    expect(overlay.classList.contains("dragging")).toBe(false);
  });
});

describe("lightbox toolbar", () => {
  const SERVER = "https://chat.example.com/api/v1/files/abc";
  const buttons = (): HTMLButtonElement[] =>
    Array.from(document.querySelectorAll<HTMLButtonElement>(".image-lightbox-toolbar button"));
  const labels = (): (string | null)[] => buttons().map((b) => b.getAttribute("aria-label"));
  const tab = (shiftKey = false): void => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }),
    );
  };

  it("renders Close, Download and Open original as labelled buttons for an external image", () => {
    openImageLightbox("blob:http://localhost/abc", "cat", { url: LINK });

    expect(labels()).toEqual(["Download image", "Open original", "Close image"]);
    for (const b of buttons()) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.title).toBe(b.getAttribute("aria-label"));
    }
  });

  it("hides Open original for a server attachment, whose address needs the token", () => {
    setServerHost("chat.example.com");
    openImageLightbox("blob:http://localhost/abc", "photo.png", { url: SERVER });

    expect(labels()).toEqual(["Download image", "Close image"]);
  });

  it("Open original opens the external address in the system browser", async () => {
    openImageLightbox("blob:http://localhost/abc", "cat", { url: LINK });

    buttons()[1]!.click();
    await flush();

    expect(openUrlMock).toHaveBeenCalledWith(LINK);
    expect(showToastMock).not.toHaveBeenCalled();
    expect(document.querySelector(".image-lightbox")).not.toBeNull();
  });

  it("Open original reports a failure to open", async () => {
    openUrlMock.mockRejectedValue(new Error("no opener"));
    openImageLightbox("blob:http://localhost/abc", "cat", { url: LINK });

    buttons()[1]!.click();
    await flush();

    expect(showToastMock).toHaveBeenCalledWith("Couldn't open the image", "error");
  });

  it("Download takes the save path the menu's Save Image takes", async () => {
    setServerHost("chat.example.com");
    saveMock.mockResolvedValue(null);
    openImageLightbox("blob:http://localhost/abc", "photo.png", { url: SERVER });

    buttons()[0]!.click();
    await flush();

    expect(saveMock).toHaveBeenCalledWith({ defaultPath: "photo.png" });
  });

  it("Download reports a failed save", async () => {
    setServerHost("chat.example.com");
    saveMock.mockRejectedValue(new Error("disk full"));
    openImageLightbox("blob:http://localhost/abc", "photo.png", { url: SERVER });

    buttons()[0]!.click();
    await flush();

    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith(
      "Download failed for photo.png \u2014 check logs for details",
      "error",
    );
  });

  it("Download reports a save that rejects outside the save functions' own handling", async () => {
    setExternalConsentChoice("auto");
    onTestFinished(() => resetExternalConsent());
    vi.spyOn(desktop.externalContent, "image").mockRejectedValue(new Error("broker down"));
    openImageLightbox("blob:http://localhost/abc", "cat.gif", { url: LINK });

    buttons()[0]!.click();
    await flush();

    expect(showToastMock).toHaveBeenCalledWith(
      "Download failed for cat.gif \u2014 check logs for details",
      "error",
    );
    expect(buttons()[0]!.hasAttribute("aria-disabled")).toBe(false);
  });

  it("a second Download click while a save is pending opens no second dialog", async () => {
    setServerHost("chat.example.com");
    let release: (path: string | null) => void = () => undefined;
    saveMock.mockReturnValue(new Promise<string | null>((r) => (release = r)));
    openImageLightbox("blob:http://localhost/abc", "photo.png", { url: SERVER });
    const download = buttons()[0]!;

    download.click();
    download.click();
    await flush();
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(download.getAttribute("aria-disabled")).toBe("true");

    release(null);
    await flush();
    expect(download.hasAttribute("aria-disabled")).toBe(false);
    download.click();
    await flush();
    expect(saveMock).toHaveBeenCalledTimes(2);
  });

  it("Tab follows the visual order Download, Open original, Close, and Shift+Tab goes back", () => {
    openImageLightbox("blob:http://localhost/abc", "cat", { url: LINK });
    const [download, open, close] = buttons();
    expect(document.activeElement).toBe(close);

    tab();
    expect(document.activeElement).toBe(download);
    tab();
    expect(document.activeElement).toBe(open);
    tab();
    expect(document.activeElement).toBe(close);
    tab(true);
    expect(document.activeElement).toBe(open);
    tab(true);
    expect(document.activeElement).toBe(download);
    tab(true);
    expect(document.activeElement).toBe(close);
  });

  it("Tab cycles between two controls when Open original is hidden", () => {
    setServerHost("chat.example.com");
    openImageLightbox("blob:http://localhost/abc", "photo.png", { url: SERVER });
    const [download, close] = buttons();

    tab();
    expect(document.activeElement).toBe(download);
    tab();
    expect(document.activeElement).toBe(close);
  });

  it("Escape still closes the lightbox and returns focus to the opener", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    openImageLightbox("blob:http://localhost/abc", "cat", { url: LINK });
    tab();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(document.querySelector(".image-lightbox")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("the zoom keys still work with a toolbar button focused", () => {
    openImageLightbox("blob:http://localhost/abc", "cat", { url: LINK });
    tab();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));

    expect(document.querySelector<HTMLElement>(".image-lightbox img")!.style.transform).toContain(
      "scale(1.3)",
    );
  });
});
