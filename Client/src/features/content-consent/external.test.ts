// B9-8: external-content consent gates every broker and GIF-proxy call. The
// "fetches nothing" cases are the failing control: before this milestone,
// rendering a message called the broker at once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { previewMock, imageMock, searchGifsMock, trendingMock } = vi.hoisted(() => ({
  previewMock: vi.fn(),
  imageMock: vi.fn(),
  searchGifsMock: vi.fn(),
  trendingMock: vi.fn(),
}));

vi.mock("../../platform/desktop/externalContent", () => ({
  externalContent: { preview: previewMock, image: imageMock },
}));
vi.mock("@lib/gifProvider", () => ({ searchGifs: searchGifsMock, getTrendingGifs: trendingMock }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { savePref } from "@lib/preferences";
import {
  clearExternalImageCache,
  fetchImageAsDataUrl,
  previewExternal,
  setServerHost,
} from "../../components/message-list/attachments";
import { clearMediaCaches, renderUrlEmbeds } from "../../components/message-list/media";
import { clearEmbedCaches } from "../../components/message-list/embeds";
import { createGifPicker } from "../../components/GifPicker";
import { nsfwConsentRequired } from "./nsfw";
import {
  EXTERNAL_CONSENT_PREF,
  externalAllowed,
  externalConsentChoice,
  forgetAdmittedItems,
  setExternalConsentChoice,
} from "./external";

const LINK = "https://news.example/story";
const IMAGE = "https://cdn.example/cat.png";
const VIDEO = "https://www.youtube.com/watch?v=abc123";
const MESSAGE = `${LINK} ${IMAGE} ${VIDEO}`;

const brokerCalls = (): number => previewMock.mock.calls.length + imageMock.mock.calls.length;

function show(content = MESSAGE): HTMLDivElement {
  const row = document.createElement("div");
  row.appendChild(renderUrlEmbeds(content));
  document.body.appendChild(row);
  return row;
}

const concealed = (root: ParentNode): HTMLButtonElement[] => [
  ...root.querySelectorAll<HTMLButtonElement>(".msg-embed-concealed button"),
];

async function answerDialog(label: string): Promise<void> {
  const dialog = await vi.waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="external-consent-dialog"]');
    if (el === null) throw new Error("no dialog yet");
    return el;
  });
  expect(dialog.textContent).toContain("can see your IP address");
  const button = [...dialog.querySelectorAll("button")].find((b) => b.textContent === label);
  button?.click();
}

function deferred(): { promise: Promise<unknown>; resolve: (v: unknown) => void } {
  let settle: ((v: unknown) => void) | undefined;
  const promise = new Promise<unknown>((r) => {
    settle = r;
  });
  return { promise, resolve: (v) => settle?.(v) };
}

let blobs = 0;
beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  previewMock.mockReset().mockResolvedValue({
    ok: true,
    value: { title: "Story", description: null, siteName: null, image: null },
  });
  imageMock
    .mockReset()
    .mockResolvedValue({ ok: true, value: new Blob(["x"], { type: "image/png" }) });
  searchGifsMock.mockReset().mockResolvedValue([]);
  trendingMock.mockReset().mockResolvedValue([]);
  URL.createObjectURL = vi.fn(() => `blob:test/${++blobs}`);
  URL.revokeObjectURL = vi.fn();
  setServerHost("chat.example");
  clearExternalImageCache();
  forgetAdmittedItems();
  clearEmbedCaches();
  clearMediaCaches();
  previewMock.mockClear(); // the partition rotation above names an empty URL
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("before consent", () => {
  it("conceals every item and fetches nothing, naming each host", async () => {
    const row = show();
    const buttons = concealed(row);
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Load external content from news.example",
      "Load external content from cdn.example",
      "Load external content from www.youtube.com",
    ]);
    for (const b of buttons) {
      b.focus();
      b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    }
    await Promise.resolve();
    expect(brokerCalls()).toBe(0);
    expect(row.querySelector("img, iframe")).toBeNull();
  });

  it("refuses at the broker seam too, so a path that forgot to ask fetches nothing", async () => {
    expect(await previewExternal(LINK)).toEqual({ ok: false, failure: "unavailable" });
    expect(await fetchImageAsDataUrl(IMAGE)).toBeNull();
    expect(brokerCalls()).toBe(0);
  });

  it("sends no GIF query to the server's proxy until the picker is admitted", async () => {
    const picker = createGifPicker({ api: {} as never, onSelect: vi.fn(), onClose: vi.fn() });
    document.body.appendChild(picker.element);
    await Promise.resolve();
    expect(trendingMock).not.toHaveBeenCalled();
    const load = picker.element.querySelector<HTMLButtonElement>(".gp-consent");
    expect(load?.textContent).toBe("Load GIFs from Klipy");

    load?.click();
    await answerDialog("Ask each time");
    await vi.waitFor(() => expect(trendingMock).toHaveBeenCalledOnce());
    picker.destroy();
  });
});

describe("the per-server choice", () => {
  it("cancelling the dialog loads nothing and records no choice", async () => {
    const row = show();
    concealed(row)[0]?.click();
    await answerDialog("Cancel");
    await Promise.resolve();
    expect(externalConsentChoice()).toBeNull();
    expect(brokerCalls()).toBe(0);
    expect(concealed(row)).toHaveLength(3);
  });

  it("'Ask each time' loads only the activated item and keeps focus on it", async () => {
    const row = show();
    concealed(row)[0]?.focus();
    concealed(row)[0]?.click();
    await answerDialog("Ask each time");
    await vi.waitFor(() => expect(previewMock).toHaveBeenCalledWith(expect.any(String), LINK));
    expect(externalConsentChoice()).toBe("ask");
    expect(concealed(row)).toHaveLength(2);
    expect(imageMock).not.toHaveBeenCalled();
    expect(row.querySelector(".msg-embed-link")?.contains(document.activeElement)).toBe(true);

    // The next item needs no dialog, only its own activation.
    concealed(row)[0]?.click();
    await vi.waitFor(() => expect(imageMock).toHaveBeenCalledOnce());
    expect(document.querySelector('[data-testid="external-consent-dialog"]')).toBeNull();
  });

  it("'Load automatically' loads every concealed item on this server only", async () => {
    const row = show();
    concealed(row)[1]?.click();
    await answerDialog("Load automatically on this server");
    await vi.waitFor(() => expect(concealed(row)).toHaveLength(0));
    expect(previewMock).toHaveBeenCalledWith(expect.any(String), LINK);
    expect(imageMock).toHaveBeenCalledWith(expect.any(String), { url: IMAGE });

    setServerHost("other.example");
    expect(externalConsentChoice()).toBeNull();
    expect(concealed(show())).toHaveLength(3);
    setServerHost("chat.example");
    expect(externalConsentChoice()).toBe("auto");
  });

  it("an item admitted one by one is forgotten on a server switch", async () => {
    setExternalConsentChoice("ask");
    concealed(show(IMAGE))[0]?.click();
    await vi.waitFor(() => expect(externalAllowed(`url:${IMAGE}`)).toBe(true));
    setServerHost("other.example");
    setServerHost("chat.example");
    expect(externalAllowed(`url:${IMAGE}`)).toBe(false);
  });

  it.each(["Ask each time", "Load automatically on this server"])(
    "a '%s' answered after the session tore down admits and records nothing",
    async (label) => {
      concealed(show(IMAGE))[0]?.click();
      const dialog = await vi.waitFor(() => {
        const el = document.querySelector('[data-testid="external-consent-dialog"]');
        if (el === null) throw new Error("no dialog yet");
        return el;
      });
      forgetAdmittedItems();
      await answerDialog(label);
      await vi.waitFor(() => expect(dialog.isConnected).toBe(false));
      await Promise.resolve();
      expect(externalConsentChoice()).toBeNull();
      expect(externalAllowed(`url:${IMAGE}`)).toBe(false);
      expect(brokerCalls()).toBe(0);
    },
  );

  it("a manual cache clear keeps an admitted item loadable", async () => {
    setExternalConsentChoice("ask");
    const row = show(IMAGE);
    concealed(row)[0]?.click();
    const img = await vi.waitFor(() => {
      const el = row.querySelector<HTMLImageElement>(".msg-image img");
      if (!el?.src.startsWith("blob:")) throw new Error("not loaded yet");
      return el;
    });
    const before = img.src;

    clearExternalImageCache();
    img.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(img.src).not.toBe(before));
    expect(img.src).toMatch(/^blob:/);
    expect(imageMock).toHaveBeenCalledTimes(2);
  });

  it("is separate from NSFW consent", () => {
    setExternalConsentChoice("auto");
    expect(nsfwConsentRequired({ nsfw: true, nsfwAcknowledged: false })).toBe(true);
  });
});

describe("YouTube playback", () => {
  it("creates no frame until the named play button is activated", async () => {
    setExternalConsentChoice("auto");
    const row = show(VIDEO);
    expect(row.querySelector("iframe")).toBeNull();
    const play = row.querySelector<HTMLButtonElement>("button.msg-embed-play");
    expect(play?.getAttribute("aria-label")).toBe("Play on YouTube");
    const note = document.getElementById(play?.getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toBe("Playing connects you to YouTube directly.");

    play?.focus();
    play?.click();
    const frame = row.querySelector("iframe");
    expect(frame?.src).toBe("https://www.youtube.com/embed/abc123?autoplay=1");
    expect(frame?.title).toBe("YouTube video player");
    expect(document.activeElement).toBe(frame);
  });
});

describe("revocation", () => {
  it("the reset re-conceals items, removes frames and revokes fetched images", async () => {
    setExternalConsentChoice("auto");
    const row = show();
    await vi.waitFor(() =>
      expect(row.querySelector(".msg-image img")?.getAttribute("src")).toBeTruthy(),
    );
    row.querySelector<HTMLElement>(".msg-embed-yt-player")?.click();
    expect(row.querySelector("iframe")).not.toBeNull();

    savePref(EXTERNAL_CONSENT_PREF, {});
    expect(concealed(row)).toHaveLength(3);
    expect(row.querySelector("iframe, img")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("drops an answer that arrives after the reset", async () => {
    setExternalConsentChoice("auto");
    const late = deferred();
    imageMock.mockReturnValueOnce(late.promise);
    const row = show(IMAGE);
    savePref(EXTERNAL_CONSENT_PREF, {});
    late.resolve({ ok: true, value: new Blob(["x"], { type: "image/png" }) });
    await Promise.resolve();
    await Promise.resolve();
    expect(row.querySelector("img")).toBeNull();
    expect(concealed(row)).toHaveLength(1);
  });

  it.each(["showLinkPreviews", "showEmbeds", "inlineMedia"])(
    "turning off %s revokes every server's grant",
    (key) => {
      setExternalConsentChoice("auto");
      savePref(key, false);
      expect(externalConsentChoice()).toBeNull();
      savePref(key, true);
    },
  );
});
