/**
 * Message rendering helpers — pure DOM builders for messages, day dividers,
 * reactions, attachments, and content parsing. XSS-safe (no innerHTML).
 */

import {
  createElement,
  setText,
  appendChildren,
} from "@lib/dom";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { Attachment } from "@lib/types";
import type { Message } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import type { MessageListOptions } from "../MessageList";

/** Module-level server host for resolving relative attachment URLs. */
let _serverHost: string | null = null;

/** Set the server host (called once from MainPage on connect). */
export function setServerHost(host: string): void {
  _serverHost = host;
}

/** Resolve a potentially relative URL to a full URL using the server host. */
function resolveServerUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  if (_serverHost !== null) {
    return `https://${_serverHost}${url}`;
  }
  return url;
}

// -- Constants ----------------------------------------------------------------

export const GROUP_THRESHOLD_MS = 5 * 60 * 1000;

const MENTION_REGEX = /@(\w+)/g;
const CODE_BLOCK_REGEX = /```([\s\S]*?)```/g;
const INLINE_CODE_REGEX = /`([^`]+)`/g;
const URL_REGEX = /https?:\/\/[^\s<>"']+/g;

// -- Formatting helpers -------------------------------------------------------

/** Parse a timestamp string, appending 'Z' if no timezone info is present
 *  so that UTC timestamps from SQLite are correctly interpreted. */
function parseTimestamp(raw: string): Date {
  // SQLite datetime('now') produces "2026-03-19 08:29:41" (UTC, no suffix).
  // If there's no Z, +, or T with offset, treat as UTC by appending Z.
  if (!raw.endsWith("Z") && !raw.includes("+") && !/T\d{2}:\d{2}:\d{2}[+-]/.test(raw)) {
    return new Date(raw.replace(" ", "T") + "Z");
  }
  return new Date(raw);
}

export function formatTime(iso: string): string {
  const d = parseTimestamp(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatFullDate(iso: string): string {
  return parseTimestamp(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function isSameDay(a: string, b: string): boolean {
  const da = parseTimestamp(a);
  const db = parseTimestamp(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

export function shouldGroup(prev: Message, curr: Message): boolean {
  if (prev.user.id !== curr.user.id) return false;
  if (prev.deleted || curr.deleted) return false;
  const dt = parseTimestamp(curr.timestamp).getTime() - parseTimestamp(prev.timestamp).getTime();
  return dt < GROUP_THRESHOLD_MS;
}

function getUserRole(userId: number): string {
  return membersStore.getState().members.get(userId)?.role ?? "member";
}

function roleColorVar(role: string): string {
  switch (role) {
    case "owner": return "var(--role-owner)";
    case "admin": return "var(--role-admin)";
    case "moderator": return "var(--role-mod)";
    default: return "var(--role-member)";
  }
}

// -- Content parsing (XSS-safe, no innerHTML) ---------------------------------

function renderInlineContent(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_CODE_REGEX)) {
    const idx = match.index;
    if (idx === undefined) continue;
    if (idx > lastIndex) {
      fragment.appendChild(renderMentions(text.slice(lastIndex, idx)));
    }
    const code = createElement("code", {});
    setText(code, match[1]!);
    fragment.appendChild(code);
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < text.length) {
    fragment.appendChild(renderMentions(text.slice(lastIndex)));
  }
  return fragment;
}

export function renderMentions(text: string): DocumentFragment {
  // First pass: split by URLs, then handle mentions in non-URL segments
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  for (const match of text.matchAll(URL_REGEX)) {
    const idx = match.index;
    if (idx === undefined) continue;
    if (idx > lastIndex) {
      fragment.appendChild(renderMentionSegment(text.slice(lastIndex, idx)));
    }
    const url = match[0];
    if (isSafeUrl(url)) {
      const link = createElement("a", {
        class: "msg-link",
        href: url,
        target: "_blank",
        rel: "noopener noreferrer",
      });
      setText(link, url);
      fragment.appendChild(link);
    } else {
      fragment.appendChild(document.createTextNode(url));
    }
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < text.length) {
    fragment.appendChild(renderMentionSegment(text.slice(lastIndex)));
  }
  return fragment;
}

/** Render @mentions within a text segment (no URLs). */
function renderMentionSegment(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  for (const match of text.matchAll(MENTION_REGEX)) {
    const idx = match.index;
    if (idx === undefined) continue;
    if (idx > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, idx)));
    }
    const span = createElement("span", { class: "mention" });
    setText(span, match[0]);
    fragment.appendChild(span);
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
  return fragment;
}

function renderMessageContent(content: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  for (const match of content.matchAll(CODE_BLOCK_REGEX)) {
    const idx = match.index;
    if (idx === undefined) continue;
    if (idx > lastIndex) {
      const text = createElement("div", { class: "msg-text" });
      text.appendChild(renderInlineContent(content.slice(lastIndex, idx)));
      fragment.appendChild(text);
    }
    const codeBlock = createElement("div", { class: "msg-codeblock" });
    setText(codeBlock, match[1]!.trim());
    fragment.appendChild(codeBlock);
    lastIndex = idx + match[0].length;
  }
  if (lastIndex === 0) {
    const text = createElement("div", { class: "msg-text" });
    text.appendChild(renderInlineContent(content));
    fragment.appendChild(text);
  } else if (lastIndex < content.length) {
    const remaining = content.slice(lastIndex).trim();
    if (remaining.length > 0) {
      const text = createElement("div", { class: "msg-text" });
      text.appendChild(renderInlineContent(remaining));
      fragment.appendChild(text);
    }
  }
  return fragment;
}

// -- URL embed rendering ------------------------------------------------------

/** Extract YouTube video ID from various YouTube URL formats. */
function extractYouTubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    // youtube.com/watch?v=ID
    if (
      (parsed.hostname === "www.youtube.com" || parsed.hostname === "youtube.com") &&
      parsed.pathname === "/watch"
    ) {
      return parsed.searchParams.get("v");
    }
    // youtu.be/ID
    if (parsed.hostname === "youtu.be") {
      const id = parsed.pathname.slice(1);
      return id.length > 0 ? id : null;
    }
    // youtube.com/embed/ID
    if (
      (parsed.hostname === "www.youtube.com" || parsed.hostname === "youtube.com") &&
      parsed.pathname.startsWith("/embed/")
    ) {
      const id = parsed.pathname.slice(7);
      return id.length > 0 ? id : null;
    }
    // youtube.com/shorts/ID
    if (
      (parsed.hostname === "www.youtube.com" || parsed.hostname === "youtube.com") &&
      parsed.pathname.startsWith("/shorts/")
    ) {
      const id = parsed.pathname.slice(8);
      return id.length > 0 ? id : null;
    }
  } catch {
    // Invalid URL
  }
  return null;
}

/** Cache for YouTube video titles to avoid re-fetching on every re-render. */
const ytTitleCache = new Map<string, string>();

/** Render a YouTube embed player with title header. */
function renderYouTubeEmbed(videoId: string, originalUrl: string): HTMLDivElement {
  const wrap = createElement("div", { class: "msg-embed msg-embed-youtube" });

  // Header: channel name + video title
  const header = createElement("div", { class: "msg-embed-yt-header" });
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
    setText(titleLink, "Loading...");
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    fetch(oembedUrl)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { title?: string } | null) => {
        const title = data?.title ?? "YouTube Video";
        ytTitleCache.set(videoId, title);
        setText(titleLink, title);
      })
      .catch(() => {
        ytTitleCache.set(videoId, "YouTube Video");
        setText(titleLink, "YouTube Video");
      });
  }

  appendChildren(header, channelLabel, titleLink);
  wrap.appendChild(header);

  // Thumbnail container with play button overlay
  const thumbWrap = createElement("div", { class: "msg-embed-yt-player" });
  const thumbUrl = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
  const thumb = createElement("img", {
    class: "msg-embed-thumb",
    src: thumbUrl,
    alt: "YouTube video",
    loading: "lazy",
  });

  const playBtn = createElement("div", { class: "msg-embed-play" }, "\u25B6");

  appendChildren(thumbWrap, thumb, playBtn);
  wrap.appendChild(thumbWrap);

  // On click thumbnail, replace with iframe player
  thumbWrap.addEventListener("click", () => {
    const iframe = document.createElement("iframe");
    iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1`;
    iframe.setAttribute("allowfullscreen", "");
    iframe.setAttribute("allow", "autoplay; encrypted-media");
    iframe.className = "msg-embed-iframe";
    thumbWrap.replaceChildren(iframe);
  }, { once: true });

  return wrap;
}

/** Extract all URLs from a message content string. */
function extractUrls(content: string): string[] {
  // Skip URLs inside code blocks
  const withoutCodeBlocks = content.replace(CODE_BLOCK_REGEX, "").replace(INLINE_CODE_REGEX, "");
  const matches = withoutCodeBlocks.match(URL_REGEX);
  return matches ?? [];
}

/** Check if a URL points directly to an image or GIF file. */
function isDirectImageUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return /\.(gif|png|jpg|jpeg|webp)$/.test(pathname);
  } catch {
    return false;
  }
}

/** Render a direct image/GIF URL as an inline image with lightbox. */
function renderInlineImage(url: string): HTMLDivElement {
  const wrap = createElement("div", {
    class: "msg-image",
    style: "max-width: 400px; contain: layout;",
  });
  const img = createElement("img", {
    src: url,
    alt: "Image",
    loading: "lazy",
    style: "max-width: 100%; max-height: 350px; display: block; border-radius: 4px; cursor: pointer;",
  }) as unknown as HTMLImageElement;

  img.addEventListener("click", () => {
    const lightbox = createElement("div", { class: "image-lightbox" });
    const lbWrap = createElement("div", { class: "image-lightbox-wrap" });
    const lbImg = createElement("img", { src: url, alt: "Image" }) as unknown as HTMLImageElement;
    const closeBtn = createElement("button", { class: "image-lightbox-close" }, "\u00D7");

    lbWrap.appendChild(lbImg);
    lightbox.appendChild(lbWrap);
    lightbox.appendChild(closeBtn);
    document.body.appendChild(lightbox);

    const closeLightbox = (): void => { lightbox.remove(); };
    closeBtn.addEventListener("click", closeLightbox);
    lightbox.addEventListener("click", (e) => {
      if (e.target === lightbox) closeLightbox();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeLightbox();
    }, { once: true });
  });

  wrap.appendChild(img);
  return wrap;
}

/** Render URL embeds (YouTube players, generic link previews). */
function renderUrlEmbeds(content: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const urls = extractUrls(content);
  const seen = new Set<string>();

  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);

    // YouTube embed
    const ytId = extractYouTubeId(url);
    if (ytId !== null) {
      fragment.appendChild(renderYouTubeEmbed(ytId, url));
      continue;
    }

    // Direct image/GIF URL — render inline
    if (isDirectImageUrl(url) && isSafeUrl(url)) {
      fragment.appendChild(renderInlineImage(url));
      continue;
    }

    // Generic URL preview (compact link card)
    if (isSafeUrl(url)) {
      fragment.appendChild(renderGenericLinkPreview(url));
    }
  }

  return fragment;
}

/** Open Graph metadata extracted from a page. */
interface OgMeta {
  readonly title: string | null;
  readonly description: string | null;
  readonly image: string | null;
  readonly siteName: string | null;
}

/** Cache for OG metadata to avoid re-fetching on re-render. */
const ogCache = new Map<string, OgMeta>();
/** URLs currently being fetched (prevents duplicate requests). */
const ogInFlight = new Set<string>();

/** Extract Open Graph meta tags from raw HTML using regex (no DOM parser needed). */
function parseOgTags(html: string): OgMeta {
  function getMetaContent(property: string): string | null {
    // Match both property="og:X" and name="og:X" patterns
    const regex = new RegExp(
      `<meta[^>]*(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']` +
      `|<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`,
      "i",
    );
    const match = html.match(regex);
    if (match !== null) {
      return match[1] ?? match[2] ?? null;
    }
    return null;
  }

  // Fallback: extract <title> tag if no og:title
  function getTitle(): string | null {
    const og = getMetaContent("og:title");
    if (og !== null) return og;
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return titleMatch?.[1]?.trim() ?? null;
  }

  // Fallback: extract meta description if no og:description
  function getDescription(): string | null {
    const og = getMetaContent("og:description");
    if (og !== null) return og;
    return getMetaContent("description");
  }

  return {
    title: getTitle(),
    description: getDescription(),
    image: getMetaContent("og:image"),
    siteName: getMetaContent("og:site_name"),
  };
}

/** Fetch OG metadata for a URL using the Tauri native HTTP client (no CORS). */
async function fetchOgMeta(url: string): Promise<OgMeta> {
  const cached = ogCache.get(url);
  if (cached !== undefined) return cached;

  // Return empty while in-flight to avoid duplicate requests
  if (ogInFlight.has(url)) {
    return { title: null, description: null, image: null, siteName: null };
  }

  ogInFlight.add(url);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await tauriFetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" },
      danger: { acceptInvalidCerts: true, acceptInvalidHostnames: false },
    } as RequestInit);
    clearTimeout(timer);

    if (!res.ok) {
      const empty: OgMeta = { title: null, description: null, image: null, siteName: null };
      ogCache.set(url, empty);
      return empty;
    }

    // Only parse HTML responses (skip binary, JSON, etc.)
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      const empty: OgMeta = { title: null, description: null, image: null, siteName: null };
      ogCache.set(url, empty);
      return empty;
    }

    const html = await res.text();
    // Only parse the first 50KB to avoid parsing huge pages
    const meta = parseOgTags(html.slice(0, 50_000));
    ogCache.set(url, meta);
    return meta;
  } catch {
    const empty: OgMeta = { title: null, description: null, image: null, siteName: null };
    ogCache.set(url, empty);
    return empty;
  } finally {
    ogInFlight.delete(url);
  }
}

/** Render a link preview card with OG metadata (title, description, image). */
function renderGenericLinkPreview(url: string): HTMLDivElement {
  const wrap = createElement("div", { class: "msg-embed msg-embed-link" });

  let displayHost = "";
  try {
    displayHost = new URL(url).hostname;
  } catch {
    displayHost = url;
  }

  const content = createElement("div", { class: "msg-embed-link-content" });

  const hostEl = createElement("div", { class: "msg-embed-host" }, displayHost);
  content.appendChild(hostEl);

  const titleEl = createElement("a", {
    class: "msg-embed-link-title",
    href: url,
    target: "_blank",
    rel: "noopener noreferrer",
  });
  content.appendChild(titleEl);

  const descEl = createElement("div", { class: "msg-embed-link-desc" });
  content.appendChild(descEl);

  wrap.appendChild(content);

  // Image container (shown if og:image exists)
  const imageWrap = createElement("div", { class: "msg-embed-link-image" });
  imageWrap.style.display = "none";
  wrap.appendChild(imageWrap);

  // Check cache first for instant render
  const cached = ogCache.get(url);
  if (cached !== undefined) {
    applyOgMeta(cached, titleEl, descEl, hostEl, imageWrap, url, displayHost);
  } else {
    // Show URL as fallback title while loading
    setText(titleEl, displayHost);
    void fetchOgMeta(url).then((meta) => {
      applyOgMeta(meta, titleEl, descEl, hostEl, imageWrap, url, displayHost);
    });
  }

  return wrap;
}

/** Apply fetched OG metadata to the preview card elements. */
function applyOgMeta(
  meta: OgMeta,
  titleEl: HTMLElement,
  descEl: HTMLElement,
  hostEl: HTMLElement,
  imageWrap: HTMLElement,
  url: string,
  displayHost: string,
): void {
  setText(titleEl, meta.title ?? displayHost);
  if (meta.siteName !== null) {
    setText(hostEl, meta.siteName);
  }
  if (meta.description !== null) {
    const desc = meta.description.length > 200
      ? meta.description.slice(0, 197) + "..."
      : meta.description;
    setText(descEl, desc);
    descEl.style.display = "";
  } else {
    descEl.style.display = "none";
  }
  if (meta.image !== null && meta.image.length > 0) {
    // Resolve relative image URLs
    let imgSrc = meta.image;
    if (imgSrc.startsWith("/")) {
      try {
        const base = new URL(url);
        imgSrc = `${base.origin}${imgSrc}`;
      } catch { /* keep as-is */ }
    }
    if (isSafeUrl(imgSrc)) {
      const img = createElement("img", {
        class: "msg-embed-link-img",
        src: imgSrc,
        alt: meta.title ?? "",
        loading: "lazy",
      });
      img.addEventListener("error", () => {
        imageWrap.style.display = "none";
      });
      imageWrap.appendChild(img);
      imageWrap.style.display = "";
    }
  }
}

// -- Image lightbox -----------------------------------------------------------

/** Open a full-screen lightbox overlay with zoom and pan. */
function openImageLightbox(src: string, alt: string): void {
  const overlay = createElement("div", { class: "image-lightbox" });

  const imgWrap = createElement("div", { class: "image-lightbox-wrap" });
  const img = createElement("img", { src, alt }) as HTMLImageElement;
  imgWrap.appendChild(img);
  overlay.appendChild(imgWrap);

  const closeBtn = createElement("button", { class: "image-lightbox-close" }, "\u2715");
  overlay.appendChild(closeBtn);

  // Zoom & pan state
  let scale = 1;
  let panX = 0;
  let panY = 0;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let panStartX = 0;
  let panStartY = 0;

  function applyTransform(): void {
    img.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }

  function resetZoom(): void {
    scale = 1;
    panX = 0;
    panY = 0;
    applyTransform();
  }

  function close(): void {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }

  // Mouse wheel zoom
  imgWrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    const newScale = Math.max(0.5, Math.min(10, scale + delta * scale));
    // Zoom towards cursor position
    const rect = img.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    const factor = newScale / scale;
    panX = panX - cx * (factor - 1);
    panY = panY - cy * (factor - 1);
    scale = newScale;
    applyTransform();
  });

  // Single click to toggle zoom, with drag detection to avoid zoom on pan
  let clickStartX = 0;
  let clickStartY = 0;

  img.addEventListener("mousedown", (e) => {
    e.preventDefault();
    clickStartX = e.clientX;
    clickStartY = e.clientY;

    if (scale > 1.1) {
      // Zoomed in — start panning
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      panStartX = panX;
      panStartY = panY;
      overlay.classList.add("dragging");
    }
  });

  img.addEventListener("click", (e) => {
    e.stopPropagation();
    // Only toggle zoom if mouse didn't move (not a pan gesture)
    const dx = Math.abs(e.clientX - clickStartX);
    const dy = Math.abs(e.clientY - clickStartY);
    if (dx > 5 || dy > 5) return;

    if (scale > 1.1) {
      resetZoom();
    } else {
      // Zoom to 3x towards click position
      const rect = img.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      scale = 3;
      panX = -cx * 2;
      panY = -cy * 2;
      applyTransform();
    }
  });

  document.addEventListener("mousemove", function onMove(e) {
    if (!isDragging) return;
    panX = panStartX + (e.clientX - dragStartX);
    panY = panStartY + (e.clientY - dragStartY);
    applyTransform();
  });

  document.addEventListener("mouseup", function onUp() {
    if (isDragging) {
      isDragging = false;
      overlay.classList.remove("dragging");
    }
  });

  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
    if (e.key === "+" || e.key === "=") {
      scale = Math.min(10, scale * 1.3);
      applyTransform();
    }
    if (e.key === "-") {
      scale = Math.max(0.5, scale / 1.3);
      applyTransform();
    }
    if (e.key === "0") resetZoom();
  }
  document.addEventListener("keydown", onKey);

  document.body.appendChild(overlay);
}

// -- Attachment rendering -----------------------------------------------------

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Image cache: memory + IndexedDB for persistence across restarts
// ---------------------------------------------------------------------------

/** In-memory cache for instant re-render. */
const memoryCache = new Map<string, string>();

/** In-flight fetch promises to prevent duplicate concurrent requests. */
const inFlight = new Map<string, Promise<string | null>>();

/** IndexedDB database name and store. */
const IDB_NAME = "owncord-image-cache";
const IDB_STORE = "images";
const IDB_VERSION = 1;

/** Open (or create) the IndexedDB database. */
function openCacheDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Read a cached data URL from IndexedDB. */
async function idbGet(url: string): Promise<string | null> {
  const db = await openCacheDb();
  if (db === null) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(url);
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Write a data URL to IndexedDB. */
async function idbPut(url: string, dataUrl: string): Promise<void> {
  const db = await openCacheDb();
  if (db === null) return;
  try {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(dataUrl, url);
  } catch {
    // IndexedDB full or unavailable — ignore
  }
}

/** Convert a Uint8Array to a base64 string. */
function uint8ToBase64(bytes: Uint8Array): string {
  // Process in chunks to avoid call stack overflow on large files
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/** Fetch an image and return a data: URI. Uses memory → IndexedDB → network. */
function fetchImageAsDataUrl(url: string): Promise<string | null> {
  // 1. Memory cache (instant)
  const cached = memoryCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);

  // 2. Deduplicate concurrent requests for the same URL
  const existing = inFlight.get(url);
  if (existing !== undefined) return existing;

  const promise = (async (): Promise<string | null> => {
    // 3. IndexedDB cache (persists across restarts)
    const idbCached = await idbGet(url);
    if (idbCached !== null) {
      memoryCache.set(url, idbCached);
      return idbCached;
    }

    // 4. Network fetch via Tauri HTTP plugin
    try {
      const res = await tauriFetch(url, {
        danger: { acceptInvalidCerts: true, acceptInvalidHostnames: false },
      } as RequestInit);
      if (!res.ok) return null;

      const contentType = res.headers.get("content-type") ?? "image/png";
      const buffer = await res.arrayBuffer();
      const base64 = uint8ToBase64(new Uint8Array(buffer));
      const dataUrl = `data:${contentType};base64,${base64}`;

      // Store in both caches
      memoryCache.set(url, dataUrl);
      void idbPut(url, dataUrl);

      return dataUrl;
    } catch (err) {
      console.error("Failed to fetch attachment image:", url, err);
      return null;
    }
  })();

  inFlight.set(url, promise);
  void promise.finally(() => inFlight.delete(url));

  return promise;
}

function renderAttachment(att: Attachment): HTMLDivElement {
  const resolvedUrl = resolveServerUrl(att.url);
  if (isImageMime(att.mime) && isSafeUrl(resolvedUrl)) {
    const wrap = createElement("div", { class: "msg-image" });

    function attachLightbox(img: HTMLImageElement): void {
      img.addEventListener("click", () => {
        openImageLightbox(img.src, att.filename);
      });
    }

    // Check cache first for instant render
    const cached = memoryCache.get(resolvedUrl);
    if (cached !== undefined) {
      const img = createElement("img", {
        src: cached,
        alt: att.filename,
      }) as HTMLImageElement;
      attachLightbox(img);
      wrap.appendChild(img);
    } else {
      // Show loading placeholder, then replace with image
      const placeholder = createElement("div", { class: "placeholder-img loading" }, att.filename);
      wrap.appendChild(placeholder);

      void fetchImageAsDataUrl(resolvedUrl).then((dataUrl) => {
        if (dataUrl !== null) {
          const img = createElement("img", {
            src: dataUrl,
            alt: att.filename,
          }) as HTMLImageElement;
          attachLightbox(img);
          placeholder.replaceWith(img);
        }
      });
    }

    return wrap;
  }
  const wrap = createElement("div", { class: "msg-file" });
  const inner = createElement("div", { class: "msg-file-inner" });
  const icon = createElement("div", { class: "msg-file-icon" }, "\uD83D\uDCC4");
  const nameEl = createElement("div", { class: "msg-file-name" }, att.filename);
  nameEl.addEventListener("click", () => {
    void downloadFile(resolvedUrl, att.filename);
  });
  const sizeEl = createElement("div", { class: "msg-file-size" }, formatFileSize(att.size));
  const info = createElement("div", {});
  appendChildren(info, nameEl, sizeEl);
  const downloadBtn = createElement("button", {
    class: "msg-file-download",
    title: "Download",
  }, "\u2B07");
  downloadBtn.addEventListener("click", () => {
    void downloadFile(resolvedUrl, att.filename);
  });
  appendChildren(inner, icon, info, downloadBtn);
  wrap.appendChild(inner);
  return wrap;
}

/** Download a file via Tauri HTTP plugin and save to disk with native dialog. */
async function downloadFile(url: string, filename: string): Promise<void> {
  try {
    // Show native save dialog with suggested filename
    const filePath = await save({ defaultPath: filename });
    if (filePath === null) return; // User cancelled

    // Fetch file data
    const res = await tauriFetch(url, {
      danger: { acceptInvalidCerts: true, acceptInvalidHostnames: false },
    } as RequestInit);
    if (!res.ok) return;

    const buffer = await res.arrayBuffer();
    await writeFile(filePath, new Uint8Array(buffer));
  } catch (err) {
    console.error("Download failed:", err);
  }
}

// -- Reaction rendering -------------------------------------------------------

function renderReactions(
  msg: Message,
  opts: MessageListOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const container = createElement("div", { class: "msg-reactions" });
  for (const reaction of msg.reactions) {
    const chip = createElement("span", {
      class: reaction.me ? "reaction-chip me" : "reaction-chip",
    });
    const emoji = document.createTextNode(reaction.emoji);
    const count = createElement("span", { class: "rc-count" }, String(reaction.count));
    chip.appendChild(emoji);
    chip.appendChild(count);
    chip.addEventListener("click", () => opts.onReactionClick(msg.id, reaction.emoji), { signal });
    container.appendChild(chip);
  }
  const addBtn = createElement("span", { class: "reaction-chip add-reaction" }, "+");
  addBtn.addEventListener("click", () => opts.onReactionClick(msg.id, ""), { signal });
  container.appendChild(addBtn);
  return container;
}

// -- DOM rendering (matches ui-mockup.html structure) -------------------------

export function renderDayDivider(iso: string): HTMLDivElement {
  const divider = createElement("div", { class: "msg-day-divider" });
  appendChildren(
    divider,
    createElement("span", { class: "line" }),
    createElement("span", { class: "date" }, formatFullDate(iso)),
    createElement("span", { class: "line" }),
  );
  return divider;
}

function renderReplyRef(
  replyToId: number,
  allMessages: readonly Message[],
): HTMLDivElement {
  const ref = allMessages.find((m) => m.id === replyToId);
  const bar = createElement("div", { class: "msg-reply-ref" });
  if (ref) {
    const preview = ref.deleted ? "[message deleted]" : ref.content.slice(0, 100);
    appendChildren(
      bar,
      createElement("span", { class: "rr-author" }, ref.user.username),
      createElement("span", { class: "rr-text" }, preview),
    );
  } else {
    setText(bar, "Reply to unknown message");
  }
  return bar;
}

function renderSystemMessage(msg: Message): HTMLDivElement {
  const el = createElement("div", { class: "system-msg" });
  const icon = createElement("span", { class: "sm-icon" }, "\u2192");
  const text = createElement("span", { class: "sm-text" });
  text.appendChild(renderMentions(msg.content));
  const time = createElement("span", { class: "sm-time" }, formatTime(msg.timestamp));
  appendChildren(el, icon, text, time);
  return el;
}

export function renderMessage(
  msg: Message,
  isGrouped: boolean,
  allMessages: readonly Message[],
  opts: MessageListOptions,
  signal: AbortSignal,
): HTMLDivElement {
  if (msg.user.username === "System") {
    return renderSystemMessage(msg);
  }

  const el = createElement("div", {
    class: isGrouped ? "message grouped" : "message",
    "data-testid": `message-${msg.id}`,
  });

  const role = getUserRole(msg.user.id);
  const initial = msg.user.username.charAt(0).toUpperCase();
  const avatar = createElement("div", {
    class: "msg-avatar",
    style: `background: ${roleColorVar(role)}`,
  }, initial);
  el.appendChild(avatar);

  if (isGrouped) {
    const hoverTime = createElement("div", {
      class: "msg-hover-time",
    }, formatTime(msg.timestamp));
    el.appendChild(hoverTime);
  }

  if (msg.replyTo !== null) {
    el.appendChild(renderReplyRef(msg.replyTo, allMessages));
  }

  const header = createElement("div", { class: "msg-header" });
  const author = createElement("span", {
    class: "msg-author",
    style: `color: ${roleColorVar(role)}`,
  }, msg.user.username);
  const time = createElement("span", { class: "msg-time" }, formatTime(msg.timestamp));
  appendChildren(header, author, time);
  el.appendChild(header);

  if (msg.deleted) {
    const text = createElement("div", { class: "msg-text" });
    text.style.fontStyle = "italic";
    text.style.color = "var(--text-muted)";
    setText(text, "[message deleted]");
    el.appendChild(text);
  } else {
    el.appendChild(renderMessageContent(msg.content));
    if (msg.editedAt !== null) {
      el.appendChild(createElement("span", { class: "msg-edited" }, "(edited)"));
    }

    for (const att of msg.attachments) {
      el.appendChild(renderAttachment(att));
    }

    // URL embeds (YouTube players, link previews)
    const embeds = renderUrlEmbeds(msg.content);
    if (embeds.childNodes.length > 0) {
      el.appendChild(embeds);
    }

    if (msg.reactions.length > 0) {
      el.appendChild(renderReactions(msg, opts, signal));
    }
  }

  if (!msg.deleted) {
    const actionsBar = createElement("div", { class: "msg-actions-bar" });

    const reactBtn = createElement("button", { "data-testid": `msg-react-${msg.id}` }, "\uD83D\uDE04");
    reactBtn.title = "React";
    reactBtn.addEventListener("click", () => opts.onReactionClick(msg.id, ""), { signal });
    actionsBar.appendChild(reactBtn);

    const replyBtn = createElement("button", { "data-testid": `msg-reply-${msg.id}` }, "\u21A9");
    replyBtn.title = "Reply";
    replyBtn.addEventListener("click", () => opts.onReplyClick(msg.id), { signal });
    actionsBar.appendChild(replyBtn);

    if (msg.user.id === opts.currentUserId) {
      const editBtn = createElement("button", { "data-testid": `msg-edit-${msg.id}` }, "\u270E");
      editBtn.title = "Edit";
      editBtn.addEventListener("click", () => opts.onEditClick(msg.id), { signal });
      actionsBar.appendChild(editBtn);
    }

    if (msg.user.id === opts.currentUserId) {
      const deleteBtn = createElement("button", { "data-testid": `msg-delete-${msg.id}` }, "\uD83D\uDDD1");
      deleteBtn.title = "Delete";
      deleteBtn.addEventListener("click", () => opts.onDeleteClick(msg.id), { signal });
      actionsBar.appendChild(deleteBtn);
    }

    el.appendChild(actionsBar);
  }

  return el;
}
