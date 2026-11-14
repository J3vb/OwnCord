import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/attachmentsMocks";

const { previewMock, imageMock, fetchMock, durable } = vi.hoisted(() => ({
  previewMock: vi.fn(),
  imageMock: vi.fn(),
  fetchMock: vi.fn(),
  /** What the durable image cache holds: what survives an app restart. */
  durable: new Map<string, Blob>(),
}));

vi.mock("../../../src/platform/desktop/externalContent", () =>
  mocks.externalContentMock(previewMock, imageMock),
);
vi.mock("@tauri-apps/plugin-http", () => mocks.httpPluginMock(fetchMock));
vi.mock("@lib/net/httpProxy", () =>
  mocks.httpProxyMock(() => Promise.resolve("http://127.0.0.1:49812")),
);
vi.mock("@stores/auth.store", () => mocks.authStoreMock(() => "session-token"));
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("/src/features/messaging/content/mediaVisibility", () => mocks.mediaVisibilityMock());
// The durable cache's IndexedDB plumbing has its own suite (attachments-cache);
// here it is a map, so a "restart" is dropping the memory caches only.
vi.mock("../../../src/features/messaging/content/attachmentIdb", async (importOriginal) => {
  let scope: string | null = null;
  return {
    ...(await importOriginal<
      typeof import("../../../src/features/messaging/content/attachmentIdb")
    >()),
    getCacheScope: () => scope,
    assignCacheScope: (next: string | null) => {
      scope = next;
    },
    idbPrune: () => Promise.resolve(),
    idbGet: (key: string) => Promise.resolve(durable.get(key) ?? null),
    idbPut: (s: string, url: string, blob: Blob) => {
      durable.set(`${s}|${url}`, blob);
      return Promise.resolve();
    },
  };
});

import {
  clearAttachmentCaches,
  setAttachmentCacheScope,
  setServerHost,
} from "../../../src/features/messaging/content/attachments";
import { isLoneImageEmbed, renderUrlEmbeds } from "../../../src/features/messaging/content/media";
import {
  normalizeLinkUrl,
  serverCardsFor,
} from "../../../src/features/messaging/content/serverPreviews";
import {
  noteServerBuildsCards,
  resetLinkPreviewSession,
} from "../../../src/features/messaging/linkPreviewSession";
import {
  EXTERNAL_CONSENT_PREF,
  externalAllowed,
  resetExternalConsent,
  setExternalConsentChoice,
} from "../../../src/features/content-consent/external";
import { savePref } from "../../../src/lib/prefs/preferences";
import type { LinkPreviewCard } from "../../../src/lib/types";

const HASH = "3a20".padEnd(64, "a");
const THUMB_PATH = `/api/v1/link-previews/images/${HASH}`;
const URL_A = "https://example.com/post";
const CARD: LinkPreviewCard = {
  url: URL_A,
  title: "A post",
  description: "What it says",
  site_name: "Example",
  image: { hash: HASH, width: 640, height: 336 },
};

let blobCounter = 0;

function mount(content: string, cards: readonly LinkPreviewCard[] | null): HTMLElement {
  const host = document.createElement("div");
  host.appendChild(renderUrlEmbeds(content, cards));
  document.body.appendChild(host);
  return host;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

/** Broker previews that asked for a page. A cache clear also names a fresh broker
 *  partition with an empty URL, which contacts no site. */
function previewFetches(): unknown[][] {
  return previewMock.mock.calls.filter((call) => call[1] !== "");
}

function pngResponse() {
  return {
    ok: true,
    headers: { get: () => "image/png" },
    arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  previewMock.mockReset().mockResolvedValue({ ok: false, failure: "unavailable" });
  imageMock.mockReset().mockResolvedValue({ ok: false, failure: "unavailable" });
  fetchMock.mockReset().mockImplementation(() => Promise.resolve(pngResponse()));
  durable.clear();
  blobCounter = 0;
  URL.createObjectURL = vi.fn(() => `blob:test/${++blobCounter}`);
  URL.revokeObjectURL = vi.fn();
  resetExternalConsent();
  resetLinkPreviewSession();
  setServerHost("chat.example");
  setAttachmentCacheScope(null);
  setAttachmentCacheScope("chat.example#1");
  previewMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  savePref("dataSaver", "off");
});

describe("rendering from the server's cards", () => {
  it("draws the card with no broker call and without external-content consent", async () => {
    expect(externalAllowed(`url:${URL_A}`)).toBe(false);
    const host = mount(`read ${URL_A}`, [CARD]);
    await settle();

    const card = host.querySelector<HTMLElement>(".msg-embed-link")!;
    expect(card.dataset["embedState"]).toBe("loaded");
    expect(card.querySelector(".msg-embed-link-title")?.textContent).toBe("A post");
    expect(card.querySelector(".msg-embed-link-title")?.getAttribute("href")).toBe(URL_A);
    expect(card.querySelector(".msg-embed-host")?.textContent).toBe("Example");
    expect(card.querySelector(".msg-embed-link-desc")?.textContent).toBe("What it says");
    expect(host.querySelector("[data-external-url]")).toBeNull();
    expect(host.querySelector(".concealed-item, [data-concealed]")).toBeNull();
    expect(previewFetches()).toEqual([]);
    expect(imageMock).not.toHaveBeenCalled();
  });

  it("fetches the thumbnail once, with the session token, and serves a restart from the durable cache", async () => {
    mount(URL_A, [CARD]);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requested, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(requested).toBe(`http://127.0.0.1:49812${THUMB_PATH}`);
    expect(init.headers["Authorization"]).toBe("Bearer session-token");
    expect([...durable.keys()]).toEqual([`chat.example#1|https://chat.example${THUMB_PATH}`]);

    // The same card again in this session: memory.
    mount(URL_A, [CARD]);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // An app restart: memory is gone, the disk is not.
    clearAttachmentCaches();
    const host = mount(URL_A, [CARD]);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLImageElement>("img.msg-embed-link-img")?.src).toMatch(/^blob:/);
    expect(previewFetches()).toEqual([]);
    expect(imageMock).not.toHaveBeenCalled();
  });

  it("matches a card to the link as the server normalises it", async () => {
    const card: LinkPreviewCard = { url: "https://example.com/Path?q=1", title: "Normalised" };
    const host = mount("see https://Example.COM:443/Path?q=1#frag", [card]);
    await settle();
    expect(host.querySelector(".msg-embed-link-title")?.textContent).toBe("Normalised");
  });

  it("draws only cards for links still in the text", async () => {
    const gone: LinkPreviewCard = { url: "https://gone.example/x", title: "Removed link" };
    const host = mount(`only ${URL_A}`, [gone, CARD]);
    await settle();
    expect(host.querySelectorAll(".msg-embed-link")).toHaveLength(1);
    expect(host.textContent).not.toContain("Removed link");
  });

  it("draws a message's cards in text order, at most five", async () => {
    const urls = Array.from({ length: 7 }, (_, i) => `https://site${i}.example/p`);
    const cards = urls.map((url, i) => ({ url, title: `T${i}` }));
    const host = mount(urls.join(" "), cards);
    await settle();
    const titles = [...host.querySelectorAll(".msg-embed-link-title")].map((el) => el.textContent);
    expect(titles).toEqual(["T0", "T1", "T2", "T3", "T4"]);
  });

  it("draws an image-only card as an inline image from the stored thumbnail", async () => {
    const url = "https://img.example/pic.png";
    const card: LinkPreviewCard = { url, image: { hash: HASH, width: 10, height: 10 } };
    const host = mount(url, [card]);
    await settle();
    expect(host.querySelector(".msg-image img")).not.toBeNull();
    expect(imageMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hides a lone image link's text only once its card has arrived", () => {
    const url = "https://img.example/pic.png";
    const card: LinkPreviewCard = { url, image: { hash: HASH, width: 10, height: 10 } };
    expect(isLoneImageEmbed(url, [])).toBe(false);
    expect(isLoneImageEmbed(url, [card])).toBe(true);
    expect(isLoneImageEmbed(url, null)).toBe(true);
  });

  it("draws a YouTube card's title and still from the server, with no oEmbed or broker call", async () => {
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const card: LinkPreviewCard = {
      url,
      title: "Never Gonna Give You Up",
      site_name: "YouTube",
      image: { hash: HASH, width: 320, height: 180 },
    };
    const host = mount(url, [card]);
    await settle();
    expect(host.querySelector(".msg-embed-yt-title")?.textContent).toBe("Never Gonna Give You Up");
    expect(host.querySelector<HTMLImageElement>("img.msg-embed-thumb")?.src).toMatch(/^blob:/);
    expect(previewFetches()).toEqual([]);
    expect(imageMock).not.toHaveBeenCalled();
  });

  it("keeps a GIF-picker image on the consented broker path so it stays animated", async () => {
    const url = "https://media.klipy.com/a/b/funny.gif";
    const card: LinkPreviewCard = { url, image: { hash: HASH, width: 10, height: 10 } };
    const host = mount(url, [card]);
    await settle();
    expect(host.querySelector("[data-external-url]")?.getAttribute("data-external-loaded")).toBe(
      "false",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isLoneImageEmbed(url, [card])).toBe(true);
  });

  it("waits for the tap under data saver, and a tap fetches only the thumbnail", async () => {
    savePref("dataSaver", "always");
    const host = mount(URL_A, [CARD]);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>(".data-saver-placeholder")!.click();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(previewFetches()).toEqual([]);
  });

  it("a message with no card yet on a cards-capable server shows nothing and never falls back", async () => {
    noteServerBuildsCards();
    const cards = serverCardsFor({});
    expect(cards).toEqual([]);
    const host = mount(URL_A, cards);
    await settle();
    expect(host.children).toHaveLength(0);
    expect(previewFetches()).toEqual([]);
  });
});

describe("the legacy path of a server that builds no cards", () => {
  it("serverCardsFor is null until the server shows it builds cards", () => {
    expect(serverCardsFor({})).toBeNull();
    expect(serverCardsFor({ linkPreviews: [] })).toEqual([]);
  });

  it("still asks for consent and does not fetch before it", async () => {
    const host = mount(URL_A, null);
    await settle();
    expect(host.querySelector("[data-external-url]")?.getAttribute("data-external-loaded")).toBe(
      "false",
    );
    expect(previewFetches()).toEqual([]);
  });

  it("fetches through the broker once the viewer consented", async () => {
    previewMock.mockResolvedValue({
      ok: true,
      value: { title: "Fetched", description: null, siteName: null, image: null },
    });
    savePref(EXTERNAL_CONSENT_PREF, {});
    setExternalConsentChoice("auto");
    const host = mount(URL_A, null);
    await settle();
    expect(previewFetches()).toHaveLength(1);
    expect(host.querySelector(".msg-embed-link-title")?.textContent).toBe("Fetched");
  });
});

describe("normalizeLinkUrl mirrors the server's spelling", () => {
  it.each([
    ["https://Example.COM", "https://example.com/"],
    ["http://example.com:80/a?b=C#f", "http://example.com/a?b=C"],
    ["https://example.com:8443/a/", "https://example.com:8443/a/"],
    ["https://example.com./x", "https://example.com/x"],
    ["https://example.com/p%20q?", "https://example.com/p%20q?"],
    ["https://bücher.example/x", "https://xn--bcher-kva.example/x"],
    ["https://[::1]:443/x", "https://[::1]/x"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeLinkUrl(raw)).toBe(expected);
  });

  it("refuses a link with credentials or a scheme the server never previews", () => {
    expect(normalizeLinkUrl("https://user:pw@example.com/")).toBeNull();
    expect(normalizeLinkUrl("ftp://example.com/")).toBeNull();
  });
});
