/** Constants and small helpers the message input modules share. */
import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { createLazyScreen } from "@components/lazyScreen";
import { isSpoilerFilename } from "../../features/messaging/spoilerAttachment";
import { authStore } from "@stores/auth.store";
import { messagingText } from "../../i18n/messaging";

// The pickers load on their first open, so their code stays out of the
// main-page chunk.
export const emojiPickerScreen = createLazyScreen(
  "emoji-picker",
  () => import("@components/EmojiPicker"),
);

export const gifPickerScreen = createLazyScreen(
  "gif-picker",
  () => import("@components/GifPicker"),
);

export const stickerPickerScreen = createLazyScreen(
  "sticker-picker",
  () => import("@components/StickerPicker"),
);

export const TYPING_THROTTLE_MS = 3_000;

export const MAX_TEXTAREA_HEIGHT = 200;

export const SEND_DEBOUNCE_MS = 200;

// The server's per-file cap arrives on auth_ok (upload_policy); an older
// server that omits it falls back to its 100 MiB request cap, and an
// advertised 0 means uploads are disabled on that server.
// The server stays authoritative: this only refuses a doomed upload early.
export const FALLBACK_MAX_FILE_SIZE = 100 * 1024 * 1024;

/** True when this server advertised max_upload_bytes 0 (uploads disabled). */
export function uploadsDisabledByServer(): boolean {
  return authStore.getState().uploadPolicy?.max_upload_bytes === 0;
}

/**
 * The extension this server's file-type policy refuses `name` for ("" for a
 * name with none in allow-only mode), or null when it is allowed. Mirrors the
 * server's check: case-insensitive, the final extension only, trailing dots
 * and spaces ignored.
 */
export function refusedExtension(name: string): string | null {
  const policy = authStore.getState().uploadPolicy;
  const trimmed = name.toLowerCase().replace(/[. ]+$/, "");
  const dot = trimmed.lastIndexOf(".");
  const ext = dot < 0 ? "" : trimmed.slice(dot + 1).trim();
  if (policy?.blocked_extensions?.includes(ext) === true) return ext;
  const allowed = policy?.allowed_extensions ?? [];
  return allowed.length === 0 || allowed.includes(ext) ? null : ext;
}

// Server/ws/command.go rejects the whole chat_send frame (as a generic parse
// error, not an attachment-specific one) once len(Attachments) > 10 -- cap
// the queue client-side so we never upload an attachment doomed to be
// orphaned by a send that can never succeed.
export const MAX_ATTACHMENTS = 10;

// The counter shows once this few characters are left, as Discord's does.
export const COUNTER_FROM_REMAINING = 200;

/** Where a file dragged in from the OS is accepted. */
export const DROP_SLOTS = ".messages-slot, .typing-slot, .input-slot";

/** The file a too-long paste becomes, the name Discord gives it. */
export const LONG_PASTE_FILENAME = "message.txt";

/**
 * Keys that move the caret without an open autocomplete popup claiming them,
 * so the popup has to be resynced against the new caret on keyup. The popup's
 * own keys are deliberately absent: it consumes ArrowUp/ArrowDown/Enter/Tab
 * (so the caret does not move) and Escape closes it, and resyncing after any
 * of those would reset the highlighted row or reopen what Escape dismissed.
 */
export const CARET_MOVE_KEYS: ReadonlySet<string> = new Set([
  "ArrowLeft",
  "ArrowRight",
  "Home", // i18n-exempt: KeyboardEvent.key value, a wire identifier, never displayed
  "End", // i18n-exempt: KeyboardEvent.key value, a wire identifier, never displayed
  "PageUp",
  "PageDown",
]);

/** Disable the GIF button and say why, instead of silently doing nothing. */
export function markGifUnavailable(gifBtn: HTMLButtonElement, reason: string): void {
  gifBtn.setAttribute("disabled", "true");
  gifBtn.title = reason;
  gifBtn.setAttribute("aria-label", messagingText("gif.ariaWithReason", { reason }));
}

/** File-icon + filename label for a non-image attachment chip. */
export function fileLabel(filename: string): [HTMLDivElement, HTMLSpanElement] {
  const icon = createElement("div", { class: "attachment-preview-file" });
  icon.appendChild(createIcon("file-text", 16));
  const nameEl = createElement("span", { class: "attachment-preview-name" }, filename);
  return [icon, nameEl];
}

export function appendFileLabel(item: HTMLDivElement, filename: string): void {
  appendChildren(item, ...fileLabel(filename));
}

/** Image types the webview cannot draw. Chat shows them through the server's
 *  JPEG preview once sent; before that the composer has only the file. */
export const UNDRAWABLE_IMAGE_MIMES = new Set(["image/heic", "image/heif", "image/tiff"]);

/** Whether the composer can preview `file` from its own bytes. */
export function isPreviewableImage(file: File): boolean {
  const base = file.type.split(";")[0]!.trim().toLowerCase();
  return base.startsWith("image/") && !UNDRAWABLE_IMAGE_MIMES.has(base);
}

/** Rename a chip's visible labels after its file was renamed. */
export function relabelChip(item: HTMLDivElement, filename: string): void {
  const nameEl = item.querySelector(".attachment-preview-name");
  if (nameEl !== null) nameEl.textContent = filename;
  const img = item.querySelector("img");
  if (img !== null) img.alt = filename;
  item
    .querySelector(".attachment-preview-remove")
    ?.setAttribute("aria-label", messagingText("attach.remove", { filename }));
}

/** The spoiler toggle's pressed state for the file's current name. Its label
 *  is fixed: the state is carried by aria-pressed alone. */
export function paintSpoilerButton(btn: HTMLButtonElement, filename: string): void {
  const marked = isSpoilerFilename(filename);
  btn.setAttribute("aria-pressed", String(marked));
  btn.classList.toggle("active", marked);
}
