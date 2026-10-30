/**
 * Text and code file preview (roadmap 8.5).
 *
 * A text/plain server attachment with a known source extension renders the
 * first lines of the file, syntax-coloured, under the usual file header, with
 * an Expand/Collapse footer. The bytes come through the authenticated server
 * fetch the other attachments use (injected by `attachments.ts`, the leaf
 * every renderer imports, so this module never imports it), capped at 64 KB.
 *
 * A fetch that fails, a file with NUL bytes, or any other surprise becomes the
 * ordinary file chip — never a stuck loading state. A small per-session LRU
 * plus an in-flight map let a row rebuilt by the virtual list render
 * synchronously at its final height.
 */

import { createElement, appendChildren, setText } from "../../lib/dom";
import { createIcon } from "../../lib/icons";
import { registerSessionReset } from "../../lib/net/sessionRegistry";
import type { Attachment } from "../../lib/types";
import { isSpoilerFilename } from "./spoilerAttachment";
import { messageStatusText } from "../../i18n/messageStatus";

/** Bytes requested, and the most that is ever decoded. */
export const TEXT_PREVIEW_MAX_BYTES = 65536;
/** Entries the per-session cache keeps; oldest read dropped first. */
export const TEXT_PREVIEW_CACHE_MAX = 50;
/** Lines shown while collapsed. */
const COLLAPSED_LINES = 6;
/** Most lines Expand builds, so a 64 KB file of newlines is not 65k nodes. */
export const TEXT_PREVIEW_MAX_LINES = 2000;

/** One highlighted run, as the message list's code-block highlighter returns it. */
export interface HighlightToken {
  readonly text: string;
  readonly cls: string | null;
  readonly ansi?: string;
}

/** What the preview needs from `attachments.ts`. */
export interface TextPreviewDeps {
  /** Authenticated fetch of a server file, with extra request headers. */
  readonly fetchFile: (url: string, headers: Record<string, string>) => Promise<Response>;
  readonly buildFileMeta: (att: Attachment, resolvedUrl: string) => HTMLElement;
  readonly buildDownloadButton: (att: Attachment, resolvedUrl: string) => HTMLElement;
  readonly renderFileChip: (att: Attachment, resolvedUrl: string) => HTMLDivElement;
  /** The message list's code-block highlighter, for a fence tag (null = plain). */
  readonly highlight: (code: string, tag: string | null) => readonly HighlightToken[];
}

type LangId =
  | "c"
  | "config"
  | "cpp"
  | "csharp"
  | "css"
  | "csv"
  | "diff"
  | "go"
  | "ini"
  | "java"
  | "javascript"
  | "json"
  | "kotlin"
  | "log"
  | "lua"
  | "markdown"
  | "php"
  | "python"
  | "ruby"
  | "rust"
  | "scss"
  | "shell"
  | "sql"
  | "swift"
  | "text"
  | "toml"
  | "tsv"
  | "typescript"
  | "yaml";

interface Language {
  /** Fence tag for the highlighter, or null for plain text. */
  readonly tag: string | null;
  /** Catalog id of the footer name (`file.lang.<id>`). */
  readonly id: LangId;
}

const plain = (id: LangId): Language => ({ tag: null, id });
const lang = (tag: string, id: LangId): Language => ({ tag, id });

/** Extensions that preview. HTML, SVG and XML are deliberately absent. */
const EXTENSIONS: Readonly<Record<string, Language>> = {
  txt: plain("text"),
  text: plain("text"),
  log: plain("log"),
  md: plain("markdown"),
  markdown: plain("markdown"),
  csv: plain("csv"),
  tsv: plain("tsv"),
  ini: plain("ini"),
  toml: plain("toml"),
  cfg: plain("config"),
  conf: plain("config"),
  rb: plain("ruby"),
  php: plain("php"),
  lua: plain("lua"),
  kt: plain("kotlin"),
  swift: plain("swift"),
  py: lang("python", "python"),
  js: lang("javascript", "javascript"),
  mjs: lang("javascript", "javascript"),
  cjs: lang("javascript", "javascript"),
  jsx: lang("javascript", "javascript"),
  ts: lang("typescript", "typescript"),
  tsx: lang("typescript", "typescript"),
  json: lang("json", "json"),
  jsonc: lang("json", "json"),
  sql: lang("sql", "sql"),
  go: lang("go", "go"),
  rs: lang("rust", "rust"),
  c: lang("c", "c"),
  h: lang("c", "c"),
  cpp: lang("cpp", "cpp"),
  cc: lang("cpp", "cpp"),
  cxx: lang("cpp", "cpp"),
  hpp: lang("cpp", "cpp"),
  cs: lang("csharp", "csharp"),
  java: lang("java", "java"),
  sh: lang("bash", "shell"),
  bash: lang("bash", "shell"),
  zsh: lang("bash", "shell"),
  yml: lang("yaml", "yaml"),
  yaml: lang("yaml", "yaml"),
  diff: lang("diff", "diff"),
  patch: lang("diff", "diff"),
  css: lang("css", "css"),
  scss: lang("css", "scss"),
};

function languageOf(filename: string): Language | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  return Object.hasOwn(EXTENSIONS, ext) ? (EXTENSIONS[ext] ?? null) : null;
}

/** Whether `att` previews: text/plain, a source/text extension, not a spoiler.
 *  The caller has already established a safe server URL. */
export function isTextPreviewable(att: Pick<Attachment, "mime" | "filename" | "size">): boolean {
  const base = att.mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    // An empty file has no byte 0: the range request would be refused (416).
    att.size > 0 &&
    base === "text/plain" &&
    !isSpoilerFilename(att.filename) &&
    languageOf(att.filename) !== null
  );
}

// -- Fetch and cache ----------------------------------------------------------

interface TextEntry {
  readonly kind: "text";
  /** At most TEXT_PREVIEW_MAX_LINES lines of what was fetched. */
  readonly text: string;
  /** More exists than `text` holds: cut by bytes or by the line cap. */
  readonly truncated: boolean;
  /** Cut by the line cap rather than the byte limit. */
  readonly lineCapped: boolean;
  readonly lineCount: number;
}
/** A file with NUL bytes: remembered so a rebuilt row is a chip at once. */
interface BinaryEntry {
  readonly kind: "binary";
}
type Entry = TextEntry | BinaryEntry;

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<Entry | null>>();
let generation = 0;

function cacheGet(url: string): Entry | undefined {
  const hit = cache.get(url);
  if (hit === undefined) return undefined;
  // Re-insert so the Map's order is read order.
  cache.delete(url);
  cache.set(url, hit);
  return hit;
}

function cacheSet(url: string, entry: Entry): void {
  cache.delete(url);
  cache.set(url, entry);
  while (cache.size > TEXT_PREVIEW_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}

/** Drop everything held for the old session; a fetch still in flight will not
 *  write its result into the next one. `clearAttachmentCaches` calls it too, so a
 *  cache-scope change drops it with the other attachment caches. */
export function clearTextPreviewCache(): void {
  generation += 1;
  cache.clear();
  inFlight.clear();
}
void registerSessionReset("attachments:text-preview", clearTextPreviewCache, { phase: "cache" }); // app-lifetime

/** Read at most the preview limit, however much the server sends. */
async function readCapped(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader?.();
  if (reader === undefined) {
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf, 0, Math.min(buf.byteLength, TEXT_PREVIEW_MAX_BYTES));
  }
  const out = new Uint8Array(TEXT_PREVIEW_MAX_BYTES);
  let filled = 0;
  try {
    while (filled < TEXT_PREVIEW_MAX_BYTES) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      const take = Math.min(value.length, TEXT_PREVIEW_MAX_BYTES - filled);
      out.set(value.subarray(0, take), filled);
      filled += take;
    }
  } finally {
    // Reached the limit, or read() threw mid-stream: either way stop the download.
    await reader.cancel().catch(() => {});
  }
  return out.subarray(0, filled);
}

function buildEntry(data: Uint8Array, declaredSize: number): Entry {
  if (data.includes(0)) return { kind: "binary" };
  let text = new TextDecoder("utf-8", { fatal: false }).decode(data).replace(/\r\n?/g, "\n");
  // A multibyte character cut at the limit decodes to a replacement char.
  if (data.length >= TEXT_PREVIEW_MAX_BYTES && text.endsWith("�")) text = text.slice(0, -1);
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const lineCapped = lines.length > TEXT_PREVIEW_MAX_LINES;
  const kept = lineCapped ? lines.slice(0, TEXT_PREVIEW_MAX_LINES) : lines;
  return {
    kind: "text",
    text: lineCapped ? kept.join("\n") : text,
    truncated: lineCapped || declaredSize > data.length,
    lineCapped,
    lineCount: kept.length,
  };
}

/** Fetch (or join the fetch of) a file's first 64 KB. null = fetch failed. */
function loadEntry(url: string, size: number, deps: TextPreviewDeps): Promise<Entry | null> {
  const pending = inFlight.get(url);
  if (pending !== undefined) return pending;
  const gen = generation;
  const run = async (): Promise<Entry | null> => {
    try {
      // i18n-exempt: HTTP wire header value, never rendered
      const res = await deps.fetchFile(url, { Range: `bytes=0-${TEXT_PREVIEW_MAX_BYTES - 1}` });
      if (!res.ok || (res.status !== 200 && res.status !== 206)) return null;
      const entry = buildEntry(await readCapped(res), size);
      if (gen === generation) cacheSet(url, entry);
      return entry;
    } catch {
      return null;
    }
  };
  const attempt: Promise<Entry | null> = run().finally(() => {
    if (gen === generation && inFlight.get(url) === attempt) inFlight.delete(url);
  });
  inFlight.set(url, attempt);
  return attempt;
}

// -- Rendering ----------------------------------------------------------------

function buildHeader(att: Attachment, resolvedUrl: string, deps: TextPreviewDeps): HTMLElement {
  const inner = createElement("div", { class: "msg-file-inner" });
  const icon = createElement("div", { class: "msg-file-icon" });
  icon.appendChild(createIcon("file-text", 20));
  appendChildren(
    inner,
    icon,
    deps.buildFileMeta(att, resolvedUrl),
    deps.buildDownloadButton(att, resolvedUrl),
  );
  return inner;
}

/** The first `n` lines of `text` (all of it when it has fewer). */
function firstLines(text: string, n: number): { text: string; count: number } {
  let end = -1;
  let count = 0;
  for (; count < n; count++) {
    end = text.indexOf("\n", end + 1);
    if (end < 0) return { text, count: count + 1 };
  }
  return { text: text.slice(0, end), count: n };
}

/** The gutter and highlighted code for `text`, which holds `lines` lines. */
function buildScroll(
  text: string,
  lines: number,
  language: Language,
  highlight: TextPreviewDeps["highlight"],
): HTMLElement {
  const code = createElement("div", { class: "msg-textpreview-code" });
  for (const token of highlight(text, language.tag)) {
    if (token.cls === null && token.ansi === undefined) {
      code.appendChild(document.createTextNode(token.text));
      continue;
    }
    const span = createElement("span", {
      class: token.cls === null ? (token.ansi ?? "") : `tok-${token.cls}`,
    });
    setText(span, token.text);
    code.appendChild(span);
  }
  const gutter = createElement("div", { class: "msg-textpreview-gutter", "aria-hidden": "true" });
  setText(gutter, Array.from({ length: lines }, (_, i) => String(i + 1)).join("\n"));
  const scroll = createElement("div", { class: "msg-textpreview-scroll" });
  appendChildren(scroll, gutter, code);
  return scroll;
}

let bodySeq = 0;

/** The code area and its footer. Collapsed it holds only the first lines; the
 *  rest is built on the first Expand and kept. */
function buildCodeAndFooter(
  root: HTMLElement,
  entry: TextEntry,
  att: Attachment,
  language: Language,
  highlight: TextPreviewDeps["highlight"],
): HTMLElement[] {
  const more = entry.lineCount > COLLAPSED_LINES;
  const head = more ? firstLines(entry.text, COLLAPSED_LINES) : null;
  const body = createElement("div", {
    class: "msg-textpreview-body",
    id: `msg-textpreview-body-${++bodySeq}`,
  });
  body.appendChild(
    head === null
      ? buildScroll(entry.text, entry.lineCount, language, highlight)
      : buildScroll(head.text, head.count, language, highlight),
  );
  const view = createElement("div", { class: "msg-textpreview-view" });
  view.appendChild(body);

  const footer = createElement("div", { class: "msg-textpreview-foot" });
  if (more) {
    const toggle = createElement("button", {
      class: "msg-textpreview-toggle",
      type: "button",
      "aria-expanded": "false",
      "aria-controls": body.id,
    });
    const label = createElement("span");
    let built = false;
    const paint = (expanded: boolean): void => {
      setText(label, messageStatusText(expanded ? "file.previewCollapse" : "file.previewExpand"));
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.replaceChildren(createIcon(expanded ? "chevron-up" : "chevron-down", 14), label);
      // The expanded box scrolls, so the keyboard has to be able to reach it.
      if (expanded) {
        body.setAttribute("role", "region");
        body.setAttribute("tabindex", "0");
        body.setAttribute(
          "aria-label",
          messageStatusText("file.previewContents", { filename: att.filename }),
        );
      } else {
        body.removeAttribute("role");
        body.removeAttribute("tabindex");
        body.removeAttribute("aria-label");
      }
    };
    paint(false);
    toggle.addEventListener("click", () => {
      const expanded = !root.classList.contains("expanded");
      if (expanded && !built) {
        built = true;
        body.replaceChildren(buildScroll(entry.text, entry.lineCount, language, highlight));
      }
      root.classList.toggle("expanded", expanded);
      // Collapsed hides the vertical scrollbar, so start back at line 1.
      if (!expanded) body.scrollTop = 0;
      paint(expanded);
    });
    footer.appendChild(toggle);
    root.classList.add("has-more");
  }
  const langEl = createElement("span", { class: "msg-textpreview-lang" });
  setText(langEl, messageStatusText(`file.lang.${language.id}`));
  const count = createElement("span", { class: "msg-textpreview-count" });
  setText(
    count,
    messageStatusText(entry.truncated ? "file.previewLinesMore" : "file.previewLines", {
      count: entry.lineCount,
    }),
  );
  appendChildren(footer, langEl, count);

  const out: HTMLElement[] = [view, footer];
  if (entry.truncated) {
    const note = createElement("div", { class: "msg-textpreview-note" });
    setText(
      note,
      entry.lineCapped
        ? messageStatusText("file.previewTruncatedLines", { count: TEXT_PREVIEW_MAX_LINES })
        : messageStatusText("file.previewTruncated", {
            size: `${TEXT_PREVIEW_MAX_BYTES / 1024} KB`,
          }),
    );
    out.push(note);
  }
  return out;
}

/**
 * The preview for `att`. Cached text renders at once; otherwise the header
 * shows with the collapsed height reserved while the first 64 KB loads, and
 * the whole thing becomes the file chip if that does not work out.
 */
export function renderTextPreview(
  att: Attachment,
  resolvedUrl: string,
  deps: TextPreviewDeps,
): HTMLDivElement {
  const language = languageOf(att.filename) ?? plain("text");
  const root = createElement("div", {
    class: "msg-file msg-textpreview",
    role: "group",
    "aria-label": messageStatusText("file.previewRegion", { filename: att.filename }),
  });
  root.appendChild(buildHeader(att, resolvedUrl, deps));

  const toChip = (): void => {
    root.replaceWith(deps.renderFileChip(att, resolvedUrl));
  };
  const fill = (entry: TextEntry): void => {
    root.classList.remove("loading", "has-more", "expanded");
    root.replaceChildren(
      root.firstElementChild ?? buildHeader(att, resolvedUrl, deps),
      ...buildCodeAndFooter(root, entry, att, language, deps.highlight),
    );
  };

  const cached = cacheGet(resolvedUrl);
  if (cached?.kind === "binary") return deps.renderFileChip(att, resolvedUrl);
  if (cached !== undefined) {
    fill(cached);
    return root;
  }

  root.classList.add("loading");
  appendChildren(
    root,
    createElement("div", { class: "msg-textpreview-view" }, ""),
    createElement("div", { class: "msg-textpreview-foot" }),
  );
  void loadEntry(resolvedUrl, att.size, deps).then((entry) => {
    if (entry === null || entry.kind === "binary") toChip();
    else fill(entry);
  });
  return root;
}
