import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExternalContentFailure,
  ExternalContentResult,
  ExternalImageHandle,
  ExternalImageSource,
  ExternalPreview,
} from "../../src/platform/contracts/externalContent";

type PreviewResult = ExternalContentResult<ExternalPreview>;
type ImageResult = ExternalContentResult<Blob>;

const { previewMock, imageMock, mockObserveMedia } = vi.hoisted(() => ({
  previewMock: vi.fn<(partition: string, url: string) => Promise<PreviewResult>>(),
  imageMock: vi.fn<(partition: string, source: ExternalImageSource) => Promise<ImageResult>>(),
  mockObserveMedia: vi.fn(),
}));

// B9-8: this suite exercises content the viewer has already consented to;
// the consent gate itself is proven in src/features/content-consent/external.test.ts.
vi.mock("../../src/features/content-consent/external", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/content-consent/external")>()),
  externalAllowed: () => true,
}));

vi.mock("../../src/platform/desktop/externalContent", () => ({
  externalContent: { preview: previewMock, image: imageMock },
}));

vi.mock("@lib/media-visibility", () => ({
  observeMedia: mockObserveMedia,
}));

import {
  clearEmbedCaches,
  renderGenericLinkPreview,
  applyOgMeta,
} from "../../src/components/message-list/embeds";
import type { OgMeta } from "../../src/components/message-list/embeds";
import {
  clearExternalImageCache,
  externalPartition,
  setServerHost,
} from "../../src/components/message-list/attachments";

function previewOk(title: string | null): PreviewResult {
  return { ok: true, value: { title, description: null, siteName: null, image: null } };
}

function refused(failure: ExternalContentFailure): { ok: false; failure: ExternalContentFailure } {
  return { ok: false, failure };
}

/** A preview answer the test settles by hand. */
function deferredPreview(): (result: PreviewResult) => void {
  let settle: ((result: PreviewResult) => void) | null = null;
  previewMock.mockImplementationOnce(
    () =>
      new Promise<PreviewResult>((resolve) => {
        settle = resolve;
      }),
  );
  return (result) => settle?.(result);
}

let objectUrlCounter = 0;

function resetBroker(): void {
  // clearExternalImageCache names a fresh partition through preview(); run it
  // before the reset so no test counts that call.
  previewMock.mockResolvedValue(refused("blocked-destination"));
  clearExternalImageCache();
  clearEmbedCaches();
  previewMock.mockReset();
  imageMock.mockReset();
  mockObserveMedia.mockReset();
  objectUrlCounter = 0;
  URL.createObjectURL = vi.fn(() => `blob:test/${++objectUrlCounter}`);
  URL.revokeObjectURL = vi.fn();
}

describe("renderGenericLinkPreview", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    setServerHost("example.com");
    resetBroker();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not reuse OG metadata that resolves after the cache was cleared", async () => {
    const settle = deferredPreview();

    const first = renderGenericLinkPreview("https://news.example.com/post");
    document.body.appendChild(first);

    await Promise.resolve();
    clearEmbedCaches();
    settle(previewOk("Fresh"));
    await Promise.resolve();
    await Promise.resolve();

    previewMock.mockResolvedValueOnce(previewOk("Fresh"));
    const second = renderGenericLinkPreview("https://news.example.com/post");
    document.body.appendChild(second);

    await vi.waitFor(() => {
      expect(previewMock).toHaveBeenCalledTimes(2);
    });
  });

  it("does not reuse an EMPTY_OG result that resolves after the cache was cleared", async () => {
    const settle = deferredPreview();

    const first = renderGenericLinkPreview("https://news.example.com/empty");
    document.body.appendChild(first);

    await Promise.resolve();
    clearEmbedCaches();
    settle(refused("unavailable"));
    await Promise.resolve();
    await Promise.resolve();

    previewMock.mockResolvedValueOnce(previewOk("Recovered"));
    const second = renderGenericLinkPreview("https://news.example.com/empty");
    document.body.appendChild(second);

    await vi.waitFor(() => {
      expect(previewMock).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps replacement preview requests deduplicated after a clear", async () => {
    const settleFirst = deferredPreview();
    const settleSecond = deferredPreview();

    const first = renderGenericLinkPreview("https://news.example.com/race");
    document.body.appendChild(first);
    await Promise.resolve();

    clearEmbedCaches();

    const second = renderGenericLinkPreview("https://news.example.com/race");
    document.body.appendChild(second);
    await vi.waitFor(() => {
      expect(previewMock).toHaveBeenCalledTimes(2);
    });

    settleFirst(previewOk("Old"));
    await Promise.resolve();
    await Promise.resolve();

    const third = renderGenericLinkPreview("https://news.example.com/race");
    document.body.appendChild(third);
    expect(previewMock).toHaveBeenCalledTimes(2);

    settleSecond(previewOk("New"));
    await vi.waitFor(() => {
      expect(second.querySelector(".msg-embed-link-title")?.textContent).toBe("New");
    });
  });

  it("asks the broker for the preview and renders its title", async () => {
    previewMock.mockResolvedValue(previewOk("F-Droid"));

    const card = renderGenericLinkPreview("https://fdroid.org/packages");
    document.body.appendChild(card);

    await vi.waitFor(() => {
      expect(previewMock).toHaveBeenCalledWith(externalPartition(), "https://fdroid.org/packages");
    });

    await vi.waitFor(() => {
      expect(card.querySelector(".msg-embed-link-title")?.textContent).toBe("F-Droid");
    });
  });

  // The renderer no longer classifies destinations: private-address policy is
  // the broker's (Rust corpus tests in src-tauri/src/external_content.rs).
  it.each([
    ["https://127.0.0.2/internal", "127.0.0.2"],
    ["https://10.0.0.1/internal", "10.0.0.1"],
    ["https://172.16.0.1/internal", "172.16.0.1"],
    ["https://192.168.1.1/admin", "192.168.1.1"],
    ["https://100.64.0.1/internal", "100.64.0.1"],
    ["https://169.254.1.1/internal", "169.254.1.1"],
    ["https://0.0.0.0/internal", "0.0.0.0"],
    ["https://198.18.0.1/benchmark", "198.18.0.1"],
    ["https://224.0.0.1/", "224.0.0.1"],
    ["https://192.0.2.1/", "192.0.2.1"],
    ["https://[::1]/internal", "[::1]"],
    ["https://[fd00::1]/", "[fd00::1]"],
    ["https://[fe80::1]/", "[fe80::1]"],
    ["https://[::ffff:127.0.0.1]/", "[::ffff:7f00:1]"],
    ["https://[2001:db8::1]/", "[2001:db8::1]"],
  ])("leaves %s to the broker and caches its blocked-destination refusal", async (url, host) => {
    previewMock.mockResolvedValue(refused("blocked-destination"));

    const card = renderGenericLinkPreview(url);
    document.body.appendChild(card);

    await vi.waitFor(() => {
      expect(previewMock).toHaveBeenCalledWith(externalPartition(), url);
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(card.querySelector(".msg-embed-link-title")?.textContent).toBe(host);
    expect(card.querySelector("img")).toBeNull();
    expect(imageMock).not.toHaveBeenCalled();

    const again = renderGenericLinkPreview(url);
    document.body.appendChild(again);
    expect(again.querySelector(".msg-embed-link-title")?.textContent).toBe(host);
    expect(previewMock).toHaveBeenCalledTimes(1);
  });

  it("gives the configured OwnCord server no exemption from the broker", async () => {
    setServerHost("LOCALHOST:8080");
    previewMock.mockResolvedValue(refused("blocked-destination"));

    const card = renderGenericLinkPreview("https://localhost:8080/docs");
    document.body.appendChild(card);

    await vi.waitFor(() => {
      expect(previewMock).toHaveBeenCalledWith(externalPartition(), "https://localhost:8080/docs");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(card.querySelector(".msg-embed-link-title")?.textContent).toBe("localhost");
  });

  it("leaves malformed URLs to the broker and shows the raw text on refusal", async () => {
    previewMock.mockResolvedValue(refused("blocked-destination"));

    const card = renderGenericLinkPreview("not-a-valid-url");
    document.body.appendChild(card);

    await vi.waitFor(() => {
      expect(previewMock).toHaveBeenCalledWith(externalPartition(), "not-a-valid-url");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(card.querySelector(".msg-embed-link-title")?.textContent).toBe("not-a-valid-url");
  });

  it("falls back to the hostname on a wrong-type refusal and caches it", async () => {
    previewMock.mockResolvedValue(refused("wrong-type"));

    const card = renderGenericLinkPreview("https://api.example.com/data.json");
    document.body.appendChild(card);

    await vi.waitFor(() => {
      expect(previewMock).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(card.querySelector(".msg-embed-link-title")?.textContent).toBe("api.example.com");
    });

    const again = renderGenericLinkPreview("https://api.example.com/data.json");
    document.body.appendChild(again);
    expect(again.querySelector(".msg-embed-link-title")?.textContent).toBe("api.example.com");
    expect(previewMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the hostname when the broker is unavailable and caches it", async () => {
    previewMock.mockResolvedValue(refused("unavailable"));

    const card = renderGenericLinkPreview("https://error.example.com/page");
    document.body.appendChild(card);

    await vi.waitFor(() => {
      expect(previewMock).toHaveBeenCalled();
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(card.querySelector(".msg-embed-link-title")?.textContent).toBe("error.example.com");

    const again = renderGenericLinkPreview("https://error.example.com/page");
    document.body.appendChild(again);
    expect(again.querySelector(".msg-embed-link-title")?.textContent).toBe("error.example.com");
    expect(previewMock).toHaveBeenCalledTimes(1);
  });

  it("marks a refusal as a typed failed state with no retry for a policy refusal", async () => {
    previewMock.mockResolvedValue(refused("blocked-destination"));

    const card = renderGenericLinkPreview("https://blocked.example.com/x");
    document.body.appendChild(card);

    await vi.waitFor(() => {
      expect(card.dataset.embedState).toBe("failed");
    });
    expect(card.dataset.embedFailure).toBe("blocked-destination");
    expect(card.querySelector(".msg-embed-status")?.textContent).toBe("Preview unavailable");
    // A policy refusal is not retryable; the retry stays hidden.
    expect((card.querySelector(".msg-embed-retry") as HTMLElement).hidden).toBe(true);
    // The refusal is distinguishable from a loaded card.
    expect(card.dataset.embedState).not.toBe("loaded");
  });

  it("offers a bounded retry for a transient 'unavailable' answer and re-asks on click", async () => {
    previewMock.mockResolvedValueOnce(refused("unavailable"));

    const card = renderGenericLinkPreview("https://flaky.example.com/x");
    document.body.appendChild(card);

    await vi.waitFor(() => {
      expect(card.dataset.embedState).toBe("failed");
    });
    const retry = card.querySelector(".msg-embed-retry") as HTMLButtonElement;
    expect(retry.hidden).toBe(false);
    expect(retry.getAttribute("aria-label")).toBe("Retry preview");

    previewMock.mockResolvedValueOnce(previewOk("Recovered"));
    retry.click();

    await vi.waitFor(() => {
      expect(card.dataset.embedState).toBe("loaded");
    });
    expect(card.querySelector(".msg-embed-link-title")?.textContent).toBe("Recovered");
    expect(retry.hidden).toBe(true);
  });

  it("keeps keyboard focus on the retry while it re-asks and after a repeat failure", async () => {
    previewMock.mockResolvedValue(refused("unavailable"));

    const card = renderGenericLinkPreview("https://focus.example.com/x");
    document.body.appendChild(card);
    await vi.waitFor(() => {
      expect(card.dataset.embedState).toBe("failed");
    });
    const retry = card.querySelector<HTMLButtonElement>(".msg-embed-retry")!;
    retry.focus();

    retry.click();
    expect(document.activeElement).toBe(retry);
    await vi.waitFor(() => {
      expect(previewMock).toHaveBeenCalledTimes(2);
      expect(card.dataset.embedState).toBe("failed");
    });
    expect(document.activeElement).toBe(retry);
    expect(retry.hasAttribute("aria-disabled")).toBe(false);

    previewMock.mockResolvedValue(previewOk("Back"));
    retry.click();
    await vi.waitFor(() => {
      expect(card.dataset.embedState).toBe("loaded");
    });
    expect(document.activeElement).toBe(card.querySelector(".msg-embed-link-title"));
  });

  it("does not retry automatically after a refusal", async () => {
    previewMock.mockResolvedValue(refused("unavailable"));

    const card = renderGenericLinkPreview("https://still-down.example.com/x");
    document.body.appendChild(card);

    await vi.waitFor(() => {
      expect(card.dataset.embedState).toBe("failed");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Only the single render-time ask, no retry loop.
    expect(previewMock).toHaveBeenCalledTimes(1);
  });

  it("renders from cache on second call (no second preview)", async () => {
    previewMock.mockResolvedValueOnce(previewOk("Cached Title"));

    const card1 = renderGenericLinkPreview("https://cached.example.com/page");
    document.body.appendChild(card1);

    await vi.waitFor(() => {
      expect(card1.querySelector(".msg-embed-link-title")?.textContent).toBe("Cached Title");
    });

    const card2 = renderGenericLinkPreview("https://cached.example.com/page");
    document.body.appendChild(card2);
    expect(card2.querySelector(".msg-embed-link-title")?.textContent).toBe("Cached Title");
    expect(previewMock).toHaveBeenCalledTimes(1);
  });
});

// parseOgTags moved to Rust: the og_* tests in src-tauri/src/external_content.rs.

describe("applyOgMeta", () => {
  beforeEach(() => {
    setServerHost("example.com");
    resetBroker();
    previewMock.mockResolvedValue(refused("unavailable"));
  });

  function elements() {
    return {
      titleEl: document.createElement("a"),
      descEl: document.createElement("div"),
      hostEl: document.createElement("div"),
      imageWrap: document.createElement("div"),
    };
  }

  function apply(meta: OgMeta) {
    const els = elements();
    applyOgMeta(
      meta,
      els.titleEl,
      els.descEl,
      els.hostEl,
      els.imageWrap,
      "https://example.com/page",
      "example.com",
    );
    return els;
  }

  const handle = "h1" as ExternalImageHandle;

  function withImage(): OgMeta {
    return { title: "Title", description: null, image: handle, siteName: null };
  }

  async function appendedImg(imageWrap: HTMLElement): Promise<HTMLImageElement> {
    await vi.waitFor(() => {
      expect(imageWrap.querySelector("img")).not.toBeNull();
    });
    return imageWrap.querySelector("img")!;
  }

  it("sets title from meta", () => {
    const { titleEl } = apply({
      title: "Page Title",
      description: null,
      image: null,
      siteName: null,
    });
    expect(titleEl.textContent).toBe("Page Title");
  });

  it("falls back to displayHost when title is null", () => {
    const { titleEl } = apply({ title: null, description: null, image: null, siteName: null });
    expect(titleEl.textContent).toBe("example.com");
  });

  it("sets siteName when present", () => {
    const { hostEl } = apply({
      title: "Title",
      description: null,
      image: null,
      siteName: "My Site",
    });
    expect(hostEl.textContent).toBe("My Site");
  });

  it("truncates long descriptions to 200 chars", () => {
    const { descEl } = apply({
      title: "Title",
      description: "A".repeat(300),
      image: null,
      siteName: null,
    });
    expect(descEl.textContent.length).toBe(200);
    expect(descEl.textContent.endsWith("...")).toBe(true);
    expect(descEl.style.display).toBe("");
  });

  it("shows description when present and short", () => {
    const { descEl } = apply({
      title: "Title",
      description: "Short description",
      image: null,
      siteName: null,
    });
    expect(descEl.textContent).toBe("Short description");
    expect(descEl.style.display).toBe("");
  });

  it("hides description when null", () => {
    const { descEl } = apply({ title: "Title", description: null, image: null, siteName: null });
    expect(descEl.style.display).toBe("none");
  });

  it("renders the broker-fetched image as a blob: URL", async () => {
    imageMock.mockResolvedValue({ ok: true, value: new Blob(["x"], { type: "image/jpeg" }) });

    const { imageWrap } = apply(withImage());

    const img = await appendedImg(imageWrap);
    expect(imageMock).toHaveBeenCalledWith(expect.any(String), { handle: "h1" });
    expect(img.className).toBe("msg-embed-link-img");
    expect(img.getAttribute("src")).toBe("blob:test/1");
    expect(img.hasAttribute("crossorigin")).toBe(false);
    expect(imageWrap.style.display).toBe("");
  });

  for (const failure of [
    "blocked-destination",
    "oversized",
    "wrong-type",
    "unavailable",
  ] as const) {
    it(`adds no image and does not re-ask for the preview on a ${failure} refusal`, async () => {
      imageMock.mockResolvedValue(refused(failure));

      const { imageWrap } = apply(withImage());

      await vi.waitFor(() => {
        expect(imageMock).toHaveBeenCalledWith(expect.any(String), { handle: "h1" });
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(imageWrap.querySelector("img")).toBeNull();
      expect(previewMock).not.toHaveBeenCalled();
    });
  }

  function previewWith(image: string): void {
    previewMock.mockResolvedValue({
      ok: true,
      value: {
        title: "Title",
        description: null,
        siteName: null,
        image: image as ExternalImageHandle,
      },
    });
  }

  function onlyHandleAnswers(live: string): void {
    imageMock.mockImplementation(async (_partition, source) =>
      "handle" in source && source.handle === live
        ? { ok: true, value: new Blob(["x"], { type: "image/jpeg" }) }
        : refused("expired-handle"),
    );
  }

  it("re-asks for the preview once when the broker has forgotten the handle", async () => {
    previewWith("h2");
    onlyHandleAnswers("h2");

    const { imageWrap } = apply(withImage());

    const img = await appendedImg(imageWrap);
    expect(previewMock).toHaveBeenCalledTimes(1);
    expect(previewMock).toHaveBeenCalledWith(expect.any(String), "https://example.com/page");
    expect(imageMock).toHaveBeenLastCalledWith(expect.any(String), { handle: "h2" });
    expect(img.getAttribute("src")).toBe("blob:test/1");
    expect(imageWrap.style.display).toBe("");
  });

  it("re-asks for a URL's preview only once per cache epoch", async () => {
    previewWith("h2");
    imageMock.mockResolvedValue(refused("expired-handle"));

    const first = apply(withImage());
    await vi.waitFor(() => {
      expect(imageMock).toHaveBeenCalledWith(expect.any(String), { handle: "h2" });
    });
    const second = apply(withImage());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(previewMock).toHaveBeenCalledTimes(1);
    expect(imageMock).toHaveBeenCalledTimes(4);
    expect(first.imageWrap.querySelector("img")).toBeNull();
    expect(second.imageWrap.querySelector("img")).toBeNull();
  });

  it("draws the one fresh preview into every embed whose handle expired", async () => {
    previewWith("h2");
    onlyHandleAnswers("h2");

    const first = apply(withImage());
    const second = apply(withImage());

    const firstImg = await appendedImg(first.imageWrap);
    const secondImg = await appendedImg(second.imageWrap);
    expect(previewMock).toHaveBeenCalledTimes(1);
    expect(firstImg.getAttribute("src")).toBe("blob:test/1");
    expect(secondImg.getAttribute("src")).toBe("blob:test/1");
  });

  it("re-asks for the preview when an evicted image's handle has expired", async () => {
    onlyHandleAnswers("h1");
    const { imageWrap } = apply(withImage());
    const stale = await appendedImg(imageWrap);

    previewMock.mockResolvedValue(refused("unavailable"));
    clearExternalImageCache();
    previewMock.mockReset();
    previewWith("h2");
    onlyHandleAnswers("h2");
    stale.dispatchEvent(new Event("error"));

    await vi.waitFor(() => {
      expect(imageWrap.querySelector("img")?.getAttribute("src")).toBe("blob:test/2");
    });
    expect(imageWrap.querySelectorAll("img")).toHaveLength(1);
    expect(previewMock).toHaveBeenCalledTimes(1);
    expect(previewMock).toHaveBeenCalledWith(expect.any(String), "https://example.com/page");
    expect(imageWrap.style.display).toBe("");
  });

  it("hides image on error", async () => {
    imageMock.mockResolvedValue({ ok: true, value: new Blob(["x"], { type: "image/jpeg" }) });

    const { imageWrap } = apply(withImage());

    const img = await appendedImg(imageWrap);
    img.dispatchEvent(new Event("error"));

    expect(imageWrap.style.display).toBe("none");
  });

  it("does not ask the broker for an image when there is none", async () => {
    const { imageWrap } = apply({ title: "Title", description: null, image: null, siteName: null });

    await Promise.resolve();
    expect(imageMock).not.toHaveBeenCalled();
    expect(imageWrap.querySelector("img")).toBeNull();
  });

  it("calls observeMedia on GIF image load with the blob: URL", async () => {
    imageMock.mockResolvedValue({ ok: true, value: new Blob(["x"], { type: "image/gif" }) });

    const { imageWrap } = apply(withImage());

    const img = await appendedImg(imageWrap);
    img.dispatchEvent(new Event("load"));

    expect(mockObserveMedia).toHaveBeenCalledWith(img, "blob:test/1", imageWrap);
  });

  it("does not call observeMedia for a non-GIF image", async () => {
    imageMock.mockResolvedValue({ ok: true, value: new Blob(["x"], { type: "image/png" }) });

    const { imageWrap } = apply(withImage());

    const img = await appendedImg(imageWrap);
    img.dispatchEvent(new Event("load"));

    expect(mockObserveMedia).not.toHaveBeenCalled();
  });
});

// The "fetch timeout covers the body read" tests moved to Rust: the deadline is
// the broker's (the_deadline_bounds_a_response_that_never_comes).

describe("renderGenericLinkPreview — cache stale during a refusal", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    setServerHost("example.com");
    resetBroker();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("discards a wrong-type refusal when cache was cleared mid-flight", async () => {
    const settle = deferredPreview();

    const card = renderGenericLinkPreview("https://stale-nonhtml.example.com/data");
    document.body.appendChild(card);
    await Promise.resolve();

    clearEmbedCaches();
    settle(refused("wrong-type"));

    await Promise.resolve();
    await Promise.resolve();

    previewMock.mockResolvedValueOnce(previewOk("Fresh"));
    const card2 = renderGenericLinkPreview("https://stale-nonhtml.example.com/data");
    document.body.appendChild(card2);
    await vi.waitFor(() => {
      expect(previewMock).toHaveBeenCalledTimes(2);
    });
  });

  it("discards an unavailable refusal when cache was cleared mid-flight", async () => {
    const settle = deferredPreview();

    const card = renderGenericLinkPreview("https://stale-error.example.com/fail");
    document.body.appendChild(card);
    await Promise.resolve();

    clearEmbedCaches();
    settle(refused("unavailable"));

    await Promise.resolve();
    await Promise.resolve();

    previewMock.mockResolvedValueOnce(previewOk("Recovered"));
    const card2 = renderGenericLinkPreview("https://stale-error.example.com/fail");
    document.body.appendChild(card2);
    await vi.waitFor(() => {
      expect(previewMock).toHaveBeenCalledTimes(2);
    });
  });
});
