/**
 * File upload validation and preview rendering for message input.
 */

import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";

export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB matches server limit
export const ALLOWED_TYPES = [
  "image/",
  "video/",
  "audio/",
  "application/pdf",
  "text/",
  "application/zip",
  "application/x-zip-compressed",
  "application/json",
];

/** Read a File as a data: URL (more reliable than createObjectURL in WebView2). */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result as string));
    reader.addEventListener("error", () => reject(new Error("Failed to read file")));
    reader.readAsDataURL(file);
  });
}

/** Validate file size and type. Returns an error message or null. */
export function validateFile(file: File): string | null {
  if (file.size > MAX_FILE_SIZE) {
    return `File too large: ${file.name} exceeds 100 MB limit`;
  }
  if (file.type === "" || !ALLOWED_TYPES.some((t) => file.type.startsWith(t))) {
    return `${file.name} is not a supported file type`;
  }
  return null;
}

/** Build a preview item element for a file being uploaded. */
export function buildPreviewItem(
  file: File,
  signal: AbortSignal,
  onRemove: () => void,
): HTMLDivElement {
  const isImage = file.type.startsWith("image/");
  const item = createElement("div", { class: "attachment-preview-item uploading" });

  if (isImage) {
    const img = createElement("img", {
      class: "attachment-preview-img",
      alt: file.name,
    });
    item.appendChild(img);
    readFileAsDataUrl(file)
      .then((dataUrl) => {
        if (signal.aborted) return;
        img.src = dataUrl;
      })
      .catch(() => {
        if (signal.aborted) return;
        const nameEl = createElement("span", { class: "attachment-preview-name" }, file.name);
        img.replaceWith(nameEl);
      });
  } else {
    const icon = createElement("div", { class: "attachment-preview-file" });
    icon.appendChild(createIcon("file-text", 16));
    const nameEl = createElement("span", { class: "attachment-preview-name" }, file.name);
    appendChildren(item, icon, nameEl);
  }

  // Loading spinner overlay
  const spinner = createElement("div", { class: "attachment-preview-spinner" });
  spinner.appendChild(createIcon("loader", 16));
  item.appendChild(spinner);

  const removeBtn = createElement("button", {
    class: "attachment-preview-remove",
    "data-testid": "attachment-remove",
  });
  removeBtn.appendChild(createIcon("x", 14));
  removeBtn.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();
      onRemove();
    },
    { signal },
  );
  item.appendChild(removeBtn);

  return item;
}

/** Mark a preview item as uploaded (removes loading state). */
export function markPreviewUploaded(item: HTMLDivElement): void {
  item.classList.remove("uploading");
  const spinner = item.querySelector(".attachment-preview-spinner");
  spinner?.remove();
}
