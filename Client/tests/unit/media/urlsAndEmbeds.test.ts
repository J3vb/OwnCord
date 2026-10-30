import { describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/mediaMocks";
import {
  extractYouTubeId,
  renderInlineImage,
  renderYouTubeEmbed,
  extractUrls,
  renderUrlEmbeds,
  clearMediaCaches,
} from "../../../src/components/message-list/media";
import {
  oembedResponse,
  awaitImgSrc,
  syncPrefCache,
  fireImgLoad,
  useMediaHarness,
} from "../../helpers/mediaHarness";

vi.mock("../../../src/features/content-consent/external", (importOriginal) =>
  mocks.consentExternalMock(importOriginal),
);
vi.mock("../../../src/platform/desktop/externalContent", () => mocks.desktopExternalContentMock());
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@lib/prefs/mediaVisibility", () => mocks.prefsMediaVisibilityMock());
vi.mock("@lib/icons", () => mocks.iconsMock());
vi.mock("@lib/prefs/preferences", (importOriginal) => mocks.prefsPreferencesMock(importOriginal));
vi.mock("../../../src/components/message-list/attachments", (importOriginal) =>
  mocks.listAttachmentsMock(importOriginal),
);
vi.mock("../../../src/components/message-list/embeds", () => mocks.listEmbedsMock());

const { previewMock, observeMediaMock, loadPrefMock } = mocks;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("media.ts", () => {
  useMediaHarness();

  // =========================================================================
  // extractYouTubeId
  // =========================================================================

  describe("extractYouTubeId", () => {
    it("extracts ID from youtube.com/watch?v=ID", () => {
      expect(extractYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    });

    it("extracts ID from youtube.com (no www) /watch?v=ID", () => {
      expect(extractYouTubeId("https://youtube.com/watch?v=abc123")).toBe("abc123");
    });

    it("extracts ID from youtu.be/ID", () => {
      expect(extractYouTubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    });

    it("returns null for youtu.be with empty path", () => {
      expect(extractYouTubeId("https://youtu.be/")).toBeNull();
    });

    it("extracts ID from youtube.com/embed/ID", () => {
      expect(extractYouTubeId("https://www.youtube.com/embed/abc123")).toBe("abc123");
    });

    it("extracts ID from youtube.com (no www) /embed/ID", () => {
      expect(extractYouTubeId("https://youtube.com/embed/xyz789")).toBe("xyz789");
    });

    it("returns null for youtube.com/embed/ with empty ID", () => {
      expect(extractYouTubeId("https://www.youtube.com/embed/")).toBeNull();
    });

    it("extracts ID from youtube.com/shorts/ID", () => {
      expect(extractYouTubeId("https://www.youtube.com/shorts/shortId1")).toBe("shortId1");
    });

    it("extracts ID from youtube.com (no www) /shorts/ID", () => {
      expect(extractYouTubeId("https://youtube.com/shorts/shortId2")).toBe("shortId2");
    });

    it("returns null for youtube.com/shorts/ with empty ID", () => {
      expect(extractYouTubeId("https://www.youtube.com/shorts/")).toBeNull();
    });

    it("returns null for non-YouTube URLs", () => {
      expect(extractYouTubeId("https://example.com/watch?v=abc")).toBeNull();
    });

    it("returns null for invalid URL", () => {
      expect(extractYouTubeId("not a url at all")).toBeNull();
    });

    it("returns null when youtube.com/watch has no v parameter", () => {
      expect(extractYouTubeId("https://www.youtube.com/watch")).toBeNull();
    });

    it("returns null for youtube.com with non-watch path", () => {
      expect(extractYouTubeId("https://www.youtube.com/channel/abc")).toBeNull();
    });

    it.each([
      ["m.youtube.com watch", "https://m.youtube.com/watch?v=mob1"],
      ["music.youtube.com watch", "https://music.youtube.com/watch?v=mob1"],
      ["youtube.com /live/ID", "https://www.youtube.com/live/mob1"],
      ["no-www /live/ID", "https://youtube.com/live/mob1"],
      ["m.youtube.com /shorts/ID", "https://m.youtube.com/shorts/mob1"],
      ["youtube-nocookie.com watch", "https://www.youtube-nocookie.com/watch?v=mob1"],
      ["youtube-nocookie.com /embed/ID", "https://www.youtube-nocookie.com/embed/mob1"],
      ["bare youtube-nocookie.com /embed/ID", "https://youtube-nocookie.com/embed/mob1"],
    ])("extracts the ID from %s", (_label, url) => {
      expect(extractYouTubeId(url)).toBe("mob1");
    });

    it.each([
      "https://www.youtube.com/watch?v=mob1&t=90s",
      "https://youtu.be/mob1?t=90",
      "https://www.youtube.com/embed/mob1?start=90",
      "https://www.youtube.com/live/mob1?t=1h2m",
    ])("keeps the ID clean when %s carries a time offset", (url) => {
      expect(extractYouTubeId(url)).toBe("mob1");
    });

    it("returns null for an empty /live/ ID and for other hosts using the same paths", () => {
      expect(extractYouTubeId("https://www.youtube.com/live/")).toBeNull();
      expect(extractYouTubeId("https://example.com/live/mob1")).toBeNull();
      expect(extractYouTubeId("https://music.example.com/watch?v=mob1")).toBeNull();
    });
  });

  // =========================================================================
  // isGifUrl (tested indirectly through renderInlineImage)
  // =========================================================================

  describe("isGifUrl (indirect)", () => {
    /** Render, let the broker answer, fire load; report whether observeMedia ran. */
    async function treatedAsGif(url: string): Promise<boolean> {
      const wrap = renderInlineImage(url);
      await awaitImgSrc(wrap);
      fireImgLoad(wrap);
      return observeMediaMock.mock.calls.length > 0;
    }

    it("identifies .gif extension as GIF", async () => {
      expect(await treatedAsGif("https://example.com/img.gif")).toBe(true);
    });

    it("does not identify .png as GIF", async () => {
      expect(await treatedAsGif("https://example.com/img.png")).toBe(false);
    });

    it("handles malformed URL gracefully in GIF check", async () => {
      // isGifUrl uses a placeholder base and pathname.toLowerCase(), so
      // .GIF (uppercase) should be detected as GIF.
      expect(await treatedAsGif("https://example.com/image.GIF")).toBe(true);
    });
  });

  // =========================================================================
  // extractUrls
  // =========================================================================

  describe("extractUrls", () => {
    it("extracts a single URL", () => {
      const urls = extractUrls("Check out https://example.com");
      expect(urls).toEqual(["https://example.com"]);
    });

    it("extracts multiple URLs", () => {
      const urls = extractUrls("Visit https://a.com and https://b.com");
      expect(urls).toEqual(["https://a.com", "https://b.com"]);
    });

    it("returns empty array for text without URLs", () => {
      const urls = extractUrls("Just plain text here");
      expect(urls).toEqual([]);
    });

    it("skips URLs inside code blocks", () => {
      const urls = extractUrls("```\nhttps://hidden.com\n```");
      expect(urls).toEqual([]);
    });

    it("skips URLs inside inline code", () => {
      const urls = extractUrls("See `https://hidden.com` here");
      expect(urls).toEqual([]);
    });

    it("skips a URL that is wholly inside a spoiler", () => {
      expect(extractUrls("||https://example.com/a.png||")).toEqual([]);
    });

    it("skips a spoilered URL but keeps one outside it", () => {
      expect(extractUrls("look ||https://example.com/a.png|| and https://example.com/b")).toEqual([
        "https://example.com/b",
      ]);
    });

    it("skips a URL inside a spoiler that also holds prose", () => {
      expect(extractUrls("||see https://example.com/a.png now||")).toEqual([]);
    });

    it("skips a URL inside a spoiler that spans lines", () => {
      expect(extractUrls("||first\nhttps://example.com/a.png||")).toEqual([]);
    });

    it("leaves other URLs alone when a spoiler holds no URL", () => {
      expect(extractUrls("||secret|| https://example.com/x")).toEqual(["https://example.com/x"]);
    });

    it("does not treat a single pipe as a spoiler", () => {
      expect(extractUrls("a | https://example.com/x")).toEqual(["https://example.com/x"]);
      expect(extractUrls("a | b | https://example.com/x")).toEqual(["https://example.com/x"]);
    });

    it("does not treat an empty || || pair as a spoiler", () => {
      expect(extractUrls("|||| https://example.com/x")).toEqual(["https://example.com/x"]);
    });

    it("keeps a URL inside a spoiler whose body holds an escaped pipe", () => {
      expect(extractUrls("||secret \\|| https://example.com/a.png ||")).toEqual([]);
      expect(extractUrls("||a\\|b https://example.com/x||")).toEqual([]);
    });

    it("keeps a URL inside a spoiler that spans a blank line", () => {
      expect(extractUrls("||secret\n\nhttps://example.com/a.png||")).toEqual([]);
      expect(extractUrls("||secret\n  \nhttps://example.com/a.png||")).toEqual([]);
    });

    it("counts an escaped pipe right after the opener as spoiler content", () => {
      expect(extractUrls("||\\|a https://example.com/x||")).toEqual([]);
    });

    it("lets an escaped backslash end the spoiler normally", () => {
      expect(extractUrls("||a\\\\|| https://example.com/x")).toEqual(["https://example.com/x"]);
    });

    it("does not treat an escaped pipe outside a spoiler as hiding a URL", () => {
      expect(extractUrls("a \\| https://example.com/x")).toEqual(["https://example.com/x"]);
    });

    it("does not close a spoiler on an escaped pipe followed by a lone pipe", () => {
      expect(extractUrls("||oops \\|| https://example.com/x")).toEqual(["https://example.com/x"]);
    });

    it("does not let an unclosed spoiler hide a later URL", () => {
      expect(extractUrls("||oops https://example.com/x")).toEqual(["https://example.com/x"]);
    });

    it("extracts URLs outside code blocks but not inside", () => {
      const urls = extractUrls("https://visible.com ```https://hidden.com```");
      expect(urls).toEqual(["https://visible.com"]);
    });

    it("extracts http and https URLs", () => {
      const urls = extractUrls("http://insecure.com https://secure.com");
      expect(urls).toEqual(["http://insecure.com", "https://secure.com"]);
    });

    it("strips sentence-ending trailing punctuation, matching the linkifier", () => {
      const urls = extractUrls("Nice pic https://cdn.example.com/a.png.");
      expect(urls).toEqual(["https://cdn.example.com/a.png"]);
    });

    it("strips a wrapping close-paren but keeps a balanced one from the URL itself", () => {
      const wrapped = extractUrls("(https://cdn.example.com/a.png)");
      expect(wrapped).toEqual(["https://cdn.example.com/a.png"]);

      const balanced = extractUrls(
        "See https://en.wikipedia.org/wiki/Rust_(programming_language) for details",
      );
      expect(balanced).toEqual(["https://en.wikipedia.org/wiki/Rust_(programming_language)"]);
    });

    it("strips trailing punctuation from a YouTube link so it resolves to a valid video id", () => {
      const urls = extractUrls("Check https://youtu.be/dQw4w9WgXcQ.");
      expect(urls).toEqual(["https://youtu.be/dQw4w9WgXcQ"]);
    });
  });

  // =========================================================================
  // renderUrlEmbeds
  // =========================================================================

  describe("renderUrlEmbeds", () => {
    it("renders YouTube embed for YouTube URLs", () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => fallback);
      previewMock.mockResolvedValue(oembedResponse("YT Video"));

      const fragment = renderUrlEmbeds("Check this: https://www.youtube.com/watch?v=test1");

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.querySelector(".msg-embed-youtube")).not.toBeNull();
    });

    it("renders inline image for direct image URLs", () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => fallback);

      const fragment = renderUrlEmbeds("Image: https://example.com/photo.png");

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.querySelector(".msg-image")).not.toBeNull();
    });

    it("renders generic link preview for non-image, non-YouTube URLs", () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => fallback);

      const fragment = renderUrlEmbeds("Check https://example.com/article");

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.querySelector(".msg-embed-link")).not.toBeNull();
    });

    it("deduplicates URLs in the same message", () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => fallback);

      const url = "https://example.com/photo.jpg";
      const fragment = renderUrlEmbeds(`${url} and ${url}`);

      const container = document.createElement("div");
      container.appendChild(fragment);
      const images = container.querySelectorAll(".msg-image");
      expect(images.length).toBe(1);
    });

    it("skips YouTube embed when showEmbeds is disabled", () => {
      loadPrefMock.mockImplementation((key: string, _fallback: unknown) => {
        if (key === "showEmbeds") return false;
        return true;
      });
      syncPrefCache();

      const fragment = renderUrlEmbeds("https://www.youtube.com/watch?v=skip1");

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.querySelector(".msg-embed-youtube")).toBeNull();
    });

    it("skips inline images when inlineMedia is disabled", () => {
      loadPrefMock.mockImplementation((key: string, _fallback: unknown) => {
        if (key === "inlineMedia") return false;
        return true;
      });
      syncPrefCache();

      const fragment = renderUrlEmbeds("https://example.com/photo.png");

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.querySelector(".msg-image")).toBeNull();
    });

    it("skips link previews when showLinkPreviews is disabled", () => {
      loadPrefMock.mockImplementation((key: string, _fallback: unknown) => {
        if (key === "showLinkPreviews") return false;
        return true;
      });
      syncPrefCache();

      const fragment = renderUrlEmbeds("https://example.com/article");

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.querySelector(".msg-embed-link")).toBeNull();
    });

    it("produces empty fragment when all preferences are disabled", () => {
      loadPrefMock.mockReturnValue(false);
      syncPrefCache();

      const fragment = renderUrlEmbeds(
        "https://www.youtube.com/watch?v=abc https://example.com/pic.png https://example.com/page",
      );

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.children.length).toBe(0);
    });

    it("does not render embeds for unsafe URLs", () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => fallback);

      // ftp:// is not a safe URL (only http/https)
      const fragment = renderUrlEmbeds("ftp://example.com/photo.png");

      const container = document.createElement("div");
      container.appendChild(fragment);
      // ftp URL won't match URL_REGEX (which only matches http/https)
      expect(container.children.length).toBe(0);
    });

    it("renders multiple different embed types in a single message", () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => fallback);
      previewMock.mockResolvedValue(oembedResponse("Video"));

      const fragment = renderUrlEmbeds(
        "Video: https://www.youtube.com/watch?v=multi1 Image: https://example.com/pic.jpg Article: https://example.com/news",
      );

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.querySelector(".msg-embed-youtube")).not.toBeNull();
      expect(container.querySelector(".msg-image")).not.toBeNull();
      expect(container.querySelector(".msg-embed-link")).not.toBeNull();
    });

    it("produces empty fragment for message with no URLs", () => {
      loadPrefMock.mockImplementation((key: string, fallback: unknown) => fallback);

      const fragment = renderUrlEmbeds("Just a plain message with no links");

      const container = document.createElement("div");
      container.appendChild(fragment);
      expect(container.children.length).toBe(0);
    });
  });

  // =========================================================================
  // clearMediaCaches
  // =========================================================================

  describe("clearMediaCaches", () => {
    it("clears image height cache", async () => {
      const url = "https://example.com/clear-test.jpg";
      // First render and cache height
      const wrap = renderInlineImage(url);
      document.body.appendChild(wrap);
      await awaitImgSrc(wrap);
      Object.defineProperty(wrap, "offsetHeight", { value: 250, configurable: true });
      Object.defineProperty(wrap, "offsetWidth", { value: 400, configurable: true });
      fireImgLoad(wrap);

      // Verify cached
      const wrap2 = renderInlineImage(url);
      expect(wrap2.style.aspectRatio).toBe("400 / 250");

      // Clear caches
      clearMediaCaches();

      // Should now use default
      const wrap3 = renderInlineImage(url);
      expect(wrap3.style.minHeight).toBe("200px");
    });

    it("clears YouTube title cache", async () => {
      previewMock.mockResolvedValueOnce(oembedResponse("Original Title"));

      const embed1 = renderYouTubeEmbed("clear1", "https://www.youtube.com/watch?v=clear1");
      document.body.appendChild(embed1);

      await vi.waitFor(() => {
        expect(embed1.querySelector(".msg-embed-yt-title")?.textContent).toBe("Original Title");
      });

      clearMediaCaches();

      // After clearing, should fetch again
      previewMock.mockResolvedValueOnce(oembedResponse("New Title"));

      const embed2 = renderYouTubeEmbed("clear1", "https://www.youtube.com/watch?v=clear1");
      document.body.appendChild(embed2);

      // Should show "Loading..." initially (not cached)
      expect(embed2.querySelector(".msg-embed-yt-title")?.textContent).toBe("Loading...");

      await vi.waitFor(() => {
        expect(embed2.querySelector(".msg-embed-yt-title")?.textContent).toBe("New Title");
      });
    });
  });
});
