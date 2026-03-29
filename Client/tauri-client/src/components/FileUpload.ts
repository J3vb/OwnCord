// Step 8.59 — File upload component with drag-and-drop, preview, and progress.
// Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.

import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";

export interface FileUploadOptions {
  readonly onUpload: (file: File) => Promise<void>;
  readonly maxSizeMb?: number;
}

const DEFAULT_MAX_SIZE_MB = 10;

export type FileUploadComponent = MountableComponent & { openPicker(): void };

export function createFileUpload(options: FileUploadOptions): FileUploadComponent {
  const maxBytes = (options.maxSizeMb ?? DEFAULT_MAX_SIZE_MB) * 1024 * 1024;
  const ac = new AbortController();
  const signal = ac.signal;

  let root: HTMLDivElement | null = null;
  let dropzone: HTMLDivElement;
  let fileInput: HTMLInputElement;
  let preview: HTMLDivElement;
  let thumb: HTMLImageElement;
  let nameSpan: HTMLSpanElement;
  let sizeSpan: HTMLSpanElement;
  let progressBar: HTMLDivElement;
  let cancelBtn: HTMLButtonElement;
  let errorDiv: HTMLDivElement;
  let uploadAbort: AbortController | null = null;

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function showError(message: string): void {
    setText(errorDiv, message);
    errorDiv.classList.remove("file-upload__error--hidden");
    preview.classList.add("file-upload__preview--hidden");
  }

  function resetPreview(): void {
    preview.classList.add("file-upload__preview--hidden");
    thumb.src = "";
    thumb.style.display = "none";
    setText(nameSpan, "");
    setText(sizeSpan, "");
    progressBar.style.width = "0%";
    uploadAbort = null;
    errorDiv.classList.add("file-upload__error--hidden");
  }

  function showPreview(file: File): void {
    resetPreview();
    setText(nameSpan, file.name);
    setText(sizeSpan, formatSize(file.size));
    if (file.type.startsWith("image/")) {
      const url = URL.createObjectURL(file);
      thumb.src = url;
      thumb.style.display = "block";
      thumb.onload = () => URL.revokeObjectURL(url);
    }
    preview.classList.remove("file-upload__preview--hidden");
  }

  async function handleFile(file: File): Promise<void> {
    errorDiv.classList.add("file-upload__error--hidden");
    if (file.size > maxBytes) {
      showError(`File too large (${formatSize(file.size)}). Max ${options.maxSizeMb ?? DEFAULT_MAX_SIZE_MB} MB.`);
      return;
    }
    showPreview(file);
    uploadAbort = new AbortController();
    try {
      progressBar.style.width = "50%";
      await options.onUpload(file);
      progressBar.style.width = "100%";
      setTimeout(() => resetPreview(), 1500);
    } catch (err) {
      if (uploadAbort?.signal.aborted) return;
      showError(err instanceof Error ? err.message : "Upload failed");
      resetPreview();
    }
  }

  function buildDom(): void {
    root = createElement("div", { class: "file-upload" });

    dropzone = createElement("div", { class: "file-upload__dropzone file-upload__dropzone--hidden" });
    appendChildren(dropzone, createElement("span", { class: "file-upload__droptext" }, "Drop files here"));

    fileInput = createElement("input", { class: "file-upload__input", type: "file" });
    fileInput.style.display = "none";

    preview = createElement("div", { class: "file-upload__preview file-upload__preview--hidden" });
    thumb = createElement("img", { class: "file-upload__thumb" });
    thumb.style.display = "none";
    thumb.alt = "";
    nameSpan = createElement("span", { class: "file-upload__name" });
    sizeSpan = createElement("span", { class: "file-upload__size" });
    const progressContainer = createElement("div", { class: "file-upload__progress" });
    progressBar = createElement("div", { class: "file-upload__progress-bar" });
    progressBar.style.width = "0%";
    appendChildren(progressContainer, progressBar);
    cancelBtn = createElement("button", { class: "file-upload__cancel", type: "button" });
    cancelBtn.appendChild(createIcon("x", 14));
    appendChildren(preview, thumb, nameSpan, sizeSpan, progressContainer, cancelBtn);

    errorDiv = createElement("div", { class: "file-upload__error file-upload__error--hidden" });
    appendChildren(root, dropzone, fileInput, preview, errorDiv);
  }

  function attachListeners(): void {
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) { void handleFile(file); fileInput.value = ""; }
    }, { signal });

    cancelBtn.addEventListener("click", () => {
      if (uploadAbort !== null) uploadAbort.abort();
      resetPreview();
    }, { signal });

    let dragCounter = 0;
    root!.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragCounter++;
      dropzone.classList.remove("file-upload__dropzone--hidden");
    }, { signal });

    root!.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; dropzone.classList.add("file-upload__dropzone--hidden"); }
    }, { signal });

    root!.addEventListener("dragover", (e) => e.preventDefault(), { signal });

    root!.addEventListener("drop", (e) => {
      e.preventDefault();
      dragCounter = 0;
      dropzone.classList.add("file-upload__dropzone--hidden");
      const file = e.dataTransfer?.files[0];
      if (file) void handleFile(file);
    }, { signal });
  }

  function mount(container: Element): void {
    buildDom();
    attachListeners();
    container.appendChild(root!);
  }

  function destroy(): void {
    ac.abort();
    if (uploadAbort !== null) uploadAbort.abort();
    root?.remove();
    root = null;
  }

  function openPicker(): void { fileInput.click(); }

  return { mount, destroy, openPicker };
}
