/**
 * YouTube embeds: video ID extraction and the player card with its cached
 * title. A leaf of media.ts; it imports only the attachment layer.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { fetchExternalImage, previewExternal, recoverEvictedImage } from "./attachments";
import { clearImageSizes } from "./imageSizes";
import { registerSessionReset } from "@lib/net/sessionRegistry";
import { admitDerived } from "../../content-consent/external";
import { externalConsentText } from "../../../i18n/externalConsent";
import { contentText } from "../../../i18n/content";
import { dataSaverActive } from "./dataSaver";
import { renderDeferredMedia } from "./deferredMedia";

/** Bumped on every cache clear so a title that resolves late is dropped. */
let mediaCacheGeneration = 0;

// -- YouTube ------------------------------------------------------------------

/** Hosts whose URLs name a YouTube video; every one embeds through the
 *  existing www.youtube.com player, so the CSP needs no new origin. */
const YOUTUBE_HOSTS: ReadonlySet<string> = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
]);

/** Path prefixes that carry the video ID as the next segment. */
const YOUTUBE_ID_PREFIXES: readonly string[] = ["/embed/", "/shorts/", "/live/"];

/** Extract YouTube video ID from various YouTube URL formats. A `t=`/`start=`
 *  time offset is a query parameter and never part of the ID. */
export function extractYouTubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    // youtu.be/ID
    if (parsed.hostname === "youtu.be") {
      const id = parsed.pathname.slice(1);
      return id.length > 0 ? id : null;
    }
    if (!YOUTUBE_HOSTS.has(parsed.hostname)) return null;
    // youtube.com/watch?v=ID
    if (parsed.pathname === "/watch") {
      return parsed.searchParams.get("v");
    }
    // youtube.com/embed/ID, /shorts/ID, /live/ID
    for (const prefix of YOUTUBE_ID_PREFIXES) {
      if (parsed.pathname.startsWith(prefix)) {
        const id = parsed.pathname.slice(prefix.length).split("/")[0] ?? "";
        return id.length > 0 ? id : null;
      }
    }
  } catch {
    // Invalid URL
  }
  return null;
}

let ytNoteSeq = 0;

/** Cache for YouTube video titles to avoid re-fetching on every re-render (LRU at 200). */
const ytTitleCache = new Map<string, string>();
const YT_TITLE_CACHE_MAX = 200;

/** Drop the cached titles and invalidate every title fetch in flight. */
export function clearYouTubeCaches(): void {
  mediaCacheGeneration += 1;
  ytTitleCache.clear();
}

/** Every media cache: the title cache and the remembered image boxes. */
export function clearMediaCaches(): void {
  clearYouTubeCaches();
  clearImageSizes();
}
void registerSessionReset("media:caches", clearMediaCaches, { phase: "cache" }); // app-lifetime

/** Strict pattern for YouTube video IDs (alphanumeric, hyphens, underscores). */
const YOUTUBE_ID_RE = /^[\w-]{1,20}$/;

/** Render a YouTube embed player with title header. */
export function renderYouTubeEmbed(
  videoId: string,
  originalUrl: string,
  tapped = false,
): HTMLDivElement {
  if (!tapped && dataSaverActive()) {
    const deferred = renderDeferredMedia(originalUrl, () =>
      renderYouTubeEmbed(videoId, originalUrl, true),
    );
    const link = createElement(
      "a",
      { href: originalUrl, target: "_blank", rel: "noopener noreferrer" },
      originalUrl,
    );
    deferred.prepend(link);
    return deferred;
  }
  // Validate videoId to prevent injection into iframe src / img src.
  if (!YOUTUBE_ID_RE.test(videoId)) {
    const fallback = createElement("div", { class: "msg-embed" });
    const link = createElement("a", {
      href: originalUrl,
      target: "_blank",
      rel: "noopener noreferrer",
    });
    setText(link, originalUrl);
    fallback.appendChild(link);
    return fallback;
  }
  const wrap = createElement("div", { class: "msg-embed msg-embed-youtube" });

  // Header: channel name + video title
  const header = createElement("div", { class: "msg-embed-yt-header" });
  // i18n-exempt: provider name, attribution not translated
  const channelLabel = createElement("div", { class: "msg-embed-host" }, "YouTube");
  const titleLink = createElement("a", {
    class: "msg-embed-yt-title",
    href: originalUrl,
    target: "_blank",
    rel: "noopener noreferrer",
  });

  const cached = ytTitleCache.get(videoId);
  if (cached !== undefined) {
    setText(titleLink, cached);
  } else {
    setText(titleLink, contentText("youtube.title.loading"));
    const generation = mediaCacheGeneration;
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`;
    admitDerived(`url:${originalUrl}`, `url:${oembedUrl}`);
    // The broker fetches and parses the oEmbed document and hands back only
    // its title — the renderer never reads the JSON.
    void previewExternal(oembedUrl).then((result) => {
      if (generation !== mediaCacheGeneration) {
        setText(titleLink, contentText("youtube.title.fallback"));
        return;
      }
      const title =
        (result.ok ? result.value.title : null) ?? contentText("youtube.title.fallback");
      if (ytTitleCache.size >= YT_TITLE_CACHE_MAX) {
        const firstKey = ytTitleCache.keys().next().value;
        if (firstKey !== undefined) ytTitleCache.delete(firstKey);
      }
      ytTitleCache.set(videoId, title);
      setText(titleLink, title);
    });
  }

  appendChildren(header, channelLabel, titleLink);
  wrap.appendChild(header);

  // Thumbnail container with play button overlay
  const thumbWrap = createElement("div", { class: "msg-embed-yt-player" });
  const thumbUrl = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
  const thumb = createElement("img", {
    class: "msg-embed-thumb",
    alt: contentText("youtube.thumbAlt"),
    loading: "lazy",
  });
  admitDerived(`url:${originalUrl}`, `url:${thumbUrl}`);
  recoverEvictedImage(thumb, { url: thumbUrl });
  void fetchExternalImage({ url: thumbUrl }).then((src) => {
    if (src !== null) thumb.src = src;
  });

  // Playback is a separate deliberate act: the frame talks to YouTube
  // itself, outside the broker's byte-fetch boundary, and the note says so.
  const note = createElement(
    "div",
    { class: "msg-embed-link-desc", id: `yt-note-${videoId}-${++ytNoteSeq}` },
    externalConsentText("youtube.note"),
  );
  header.appendChild(note);
  const playBtn = createElement("button", {
    type: "button",
    class: "msg-embed-play",
    "aria-label": externalConsentText("youtube.play"),
    "aria-describedby": note.id,
  });
  playBtn.appendChild(createIcon("play", 24));

  appendChildren(thumbWrap, thumb, playBtn);
  wrap.appendChild(thumbWrap);

  // On click (or Enter/Space on the play button), replace with the player
  thumbWrap.addEventListener(
    "click",
    () => {
      const iframe = document.createElement("iframe");
      iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1`;
      iframe.setAttribute("allowfullscreen", "");
      iframe.setAttribute("allow", "autoplay; encrypted-media");
      iframe.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-presentation allow-popups",
      );
      iframe.className = "msg-embed-iframe";
      iframe.title = externalConsentText("youtube.frame");
      const hadFocus = thumbWrap.contains(document.activeElement);
      thumbWrap.replaceChildren(iframe);
      if (hadFocus) iframe.focus();
    },
    { once: true },
  );

  return wrap;
}
