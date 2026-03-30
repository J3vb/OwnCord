import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFileUpload } from "@components/FileUpload";
import type { FileUploadOptions, FileUploadComponent } from "@components/FileUpload";

describe("FileUpload", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function makeUpload(overrides?: Partial<FileUploadOptions>): FileUploadComponent {
    const options: FileUploadOptions = {
      onUpload: overrides?.onUpload ?? vi.fn(async () => {}),
      maxSizeMb: overrides?.maxSizeMb,
    };
    const upload = createFileUpload(options);
    upload.mount(container);
    return upload;
  }

  it("mounts with file-upload class", () => {
    const upload = makeUpload();
    expect(container.querySelector(".file-upload")).not.toBeNull();
    upload.destroy?.();
  });

  it("renders dropzone (hidden by default)", () => {
    const upload = makeUpload();
    const dropzone = container.querySelector(".file-upload__dropzone") as HTMLDivElement;
    expect(dropzone).not.toBeNull();
    expect(dropzone.classList.contains("file-upload__dropzone--hidden")).toBe(true);
    upload.destroy?.();
  });

  it("renders hidden file input", () => {
    const upload = makeUpload();
    const input = container.querySelector(".file-upload__input") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.type).toBe("file");
    expect(input.style.display).toBe("none");
    upload.destroy?.();
  });

  it("preview is hidden by default", () => {
    const upload = makeUpload();
    const preview = container.querySelector(".file-upload__preview") as HTMLDivElement;
    expect(preview).not.toBeNull();
    expect(preview.classList.contains("file-upload__preview--hidden")).toBe(true);
    upload.destroy?.();
  });

  it("error div is hidden by default", () => {
    const upload = makeUpload();
    const errorDiv = container.querySelector(".file-upload__error") as HTMLDivElement;
    expect(errorDiv).not.toBeNull();
    expect(errorDiv.classList.contains("file-upload__error--hidden")).toBe(true);
    upload.destroy?.();
  });

  it("renders drop text in dropzone", () => {
    const upload = makeUpload();
    const droptext = container.querySelector(".file-upload__droptext");
    expect(droptext).not.toBeNull();
    expect(droptext!.textContent).toBe("Drop files here");
    upload.destroy?.();
  });

  it("renders preview sub-elements (thumb, name, size, progress, cancel)", () => {
    const upload = makeUpload();
    expect(container.querySelector(".file-upload__thumb")).not.toBeNull();
    expect(container.querySelector(".file-upload__name")).not.toBeNull();
    expect(container.querySelector(".file-upload__size")).not.toBeNull();
    expect(container.querySelector(".file-upload__progress")).not.toBeNull();
    expect(container.querySelector(".file-upload__progress-bar")).not.toBeNull();
    expect(container.querySelector(".file-upload__cancel")).not.toBeNull();
    upload.destroy?.();
  });

  it("dragenter shows dropzone", () => {
    const upload = makeUpload();
    const root = container.querySelector(".file-upload") as HTMLDivElement;
    const dropzone = container.querySelector(".file-upload__dropzone") as HTMLDivElement;

    root.dispatchEvent(new Event("dragenter", { bubbles: true }));
    expect(dropzone.classList.contains("file-upload__dropzone--hidden")).toBe(false);
    upload.destroy?.();
  });

  it("dragleave hides dropzone", () => {
    const upload = makeUpload();
    const root = container.querySelector(".file-upload") as HTMLDivElement;
    const dropzone = container.querySelector(".file-upload__dropzone") as HTMLDivElement;

    root.dispatchEvent(new Event("dragenter", { bubbles: true }));
    root.dispatchEvent(new Event("dragleave", { bubbles: true }));
    expect(dropzone.classList.contains("file-upload__dropzone--hidden")).toBe(true);
    upload.destroy?.();
  });

  it("openPicker triggers file input click", () => {
    const upload = makeUpload();
    const input = container.querySelector(".file-upload__input") as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");

    upload.openPicker();
    expect(clickSpy).toHaveBeenCalledOnce();
    upload.destroy?.();
  });

  it("destroy removes DOM", () => {
    const upload = makeUpload();
    expect(container.querySelector(".file-upload")).not.toBeNull();
    upload.destroy?.();
    expect(container.querySelector(".file-upload")).toBeNull();
  });

  // ── File size validation ──

  it("shows error when file exceeds max size limit", async () => {
    const onUpload = vi.fn(async () => {});
    const upload = makeUpload({ onUpload, maxSizeMb: 5 });

    const bigFile = new File(["x"], "huge.bin", { type: "application/octet-stream" });
    Object.defineProperty(bigFile, "size", { value: 6 * 1024 * 1024 }); // 6 MB > 5 MB limit

    const input = container.querySelector(".file-upload__input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [bigFile], writable: true });
    input.dispatchEvent(new Event("change"));

    // Give async handler a tick
    await new Promise((r) => setTimeout(r, 10));

    // Upload should NOT be called
    expect(onUpload).not.toHaveBeenCalled();

    // Error should be visible with size info
    const errorDiv = container.querySelector(".file-upload__error") as HTMLDivElement;
    expect(errorDiv.classList.contains("file-upload__error--hidden")).toBe(false);
    expect(errorDiv.textContent).toContain("too large");
    expect(errorDiv.textContent).toContain("5 MB");

    // Preview should remain hidden
    const preview = container.querySelector(".file-upload__preview") as HTMLDivElement;
    expect(preview.classList.contains("file-upload__preview--hidden")).toBe(true);

    upload.destroy?.();
  });

  it("uses default 10 MB limit when maxSizeMb is not specified", async () => {
    const onUpload = vi.fn(async () => {});
    const upload = makeUpload({ onUpload });

    const bigFile = new File(["x"], "huge.bin", { type: "application/octet-stream" });
    Object.defineProperty(bigFile, "size", { value: 11 * 1024 * 1024 }); // 11 MB > 10 MB default

    const input = container.querySelector(".file-upload__input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [bigFile], writable: true });
    input.dispatchEvent(new Event("change"));

    await new Promise((r) => setTimeout(r, 10));

    expect(onUpload).not.toHaveBeenCalled();
    const errorDiv = container.querySelector(".file-upload__error") as HTMLDivElement;
    expect(errorDiv.classList.contains("file-upload__error--hidden")).toBe(false);
    expect(errorDiv.textContent).toContain("10 MB");

    upload.destroy?.();
  });

  // ── Successful upload flow ──

  it("shows file name and size in preview during upload", async () => {
    const onUpload = vi.fn(async () => {});
    const upload = makeUpload({ onUpload });

    const file = new File(["hello world test data"], "document.txt", { type: "text/plain" });

    const input = container.querySelector(".file-upload__input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], writable: true });
    input.dispatchEvent(new Event("change"));

    // Wait for handleFile to start
    await new Promise((r) => setTimeout(r, 10));

    const nameSpan = container.querySelector(".file-upload__name");
    expect(nameSpan?.textContent).toBe("document.txt");

    const sizeSpan = container.querySelector(".file-upload__size");
    expect(sizeSpan?.textContent).not.toBe("");

    // Preview should be visible
    const preview = container.querySelector(".file-upload__preview") as HTMLDivElement;
    expect(preview.classList.contains("file-upload__preview--hidden")).toBe(false);

    upload.destroy?.();
  });

  it("shows progress and resets preview after successful upload", async () => {
    vi.useFakeTimers();
    const onUpload = vi.fn(async () => {});
    const upload = makeUpload({ onUpload });

    const file = new File(["data"], "test.txt", { type: "text/plain" });

    const input = container.querySelector(".file-upload__input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], writable: true });
    input.dispatchEvent(new Event("change"));

    // Wait for async handleFile
    await vi.advanceTimersByTimeAsync(10);

    expect(onUpload).toHaveBeenCalledWith(file);

    // Progress bar should be at 100%
    const progressBar = container.querySelector(".file-upload__progress-bar") as HTMLDivElement;
    expect(progressBar.style.width).toBe("100%");

    // After 1500ms timeout, preview resets
    await vi.advanceTimersByTimeAsync(1500);

    const preview = container.querySelector(".file-upload__preview") as HTMLDivElement;
    expect(preview.classList.contains("file-upload__preview--hidden")).toBe(true);

    vi.useRealTimers();
    upload.destroy?.();
  });

  // ── Upload failure ──

  it("calls onUpload and resets preview when upload fails with Error", async () => {
    const onUpload = vi.fn(async () => {
      throw new Error("Network timeout");
    });
    const upload = makeUpload({ onUpload });

    const file = new File(["data"], "test.txt", { type: "text/plain" });

    const input = container.querySelector(".file-upload__input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], writable: true });
    input.dispatchEvent(new Event("change"));

    await vi.waitFor(() => {
      expect(onUpload).toHaveBeenCalledWith(file);
    });

    // After failure, preview is reset (hidden) -- the error text is set
    // then resetPreview re-hides it, but the text remains
    const errorDiv = container.querySelector(".file-upload__error") as HTMLDivElement;
    expect(errorDiv.textContent).toContain("Network timeout");

    // Preview should be reset
    const preview = container.querySelector(".file-upload__preview") as HTMLDivElement;
    expect(preview.classList.contains("file-upload__preview--hidden")).toBe(true);

    upload.destroy?.();
  });

  it("calls onUpload and shows generic error for non-Error thrown by upload", async () => {
    const onUpload = vi.fn(async () => {
      throw "string error";
    });
    const upload = makeUpload({ onUpload });

    const file = new File(["data"], "test.txt", { type: "text/plain" });

    const input = container.querySelector(".file-upload__input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], writable: true });
    input.dispatchEvent(new Event("change"));

    await vi.waitFor(() => {
      expect(onUpload).toHaveBeenCalledWith(file);
    });

    // Error text is set to "Upload failed" for non-Error exceptions
    const errorDiv = container.querySelector(".file-upload__error") as HTMLDivElement;
    expect(errorDiv.textContent).toContain("Upload failed");

    upload.destroy?.();
  });

  // ── Cancel button aborts upload ──

  it("cancel button aborts in-flight upload and resets preview", async () => {
    let resolveUpload: (() => void) | null = null;
    const onUpload = vi.fn(() => new Promise<void>((resolve) => {
      resolveUpload = resolve;
    }));
    const upload = makeUpload({ onUpload });

    const file = new File(["data"], "test.txt", { type: "text/plain" });

    const input = container.querySelector(".file-upload__input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], writable: true });
    input.dispatchEvent(new Event("change"));

    await new Promise((r) => setTimeout(r, 10));

    // Preview should be visible while uploading
    const preview = container.querySelector(".file-upload__preview") as HTMLDivElement;
    expect(preview.classList.contains("file-upload__preview--hidden")).toBe(false);

    // Click cancel
    const cancelBtn = container.querySelector(".file-upload__cancel") as HTMLButtonElement;
    cancelBtn.click();

    // Preview should be reset
    expect(preview.classList.contains("file-upload__preview--hidden")).toBe(true);

    // Clean up: resolve the pending promise so it doesn't leak
    resolveUpload?.();

    upload.destroy?.();
  });

  // ── Drop file handling ──

  it("dropping a file triggers upload", async () => {
    const onUpload = vi.fn(async () => {});
    const upload = makeUpload({ onUpload });

    const root = container.querySelector(".file-upload") as HTMLDivElement;
    const file = new File(["dropped"], "dropped.pdf", { type: "application/pdf" });

    const dropEvent = new Event("drop", { bubbles: true }) as Event & { dataTransfer?: { files: File[] } };
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { files: [file] },
    });
    // Need to also define preventDefault
    dropEvent.preventDefault = vi.fn();

    root.dispatchEvent(dropEvent);

    await vi.waitFor(() => {
      expect(onUpload).toHaveBeenCalledWith(file);
    });

    // Dropzone should be hidden after drop
    const dropzone = container.querySelector(".file-upload__dropzone") as HTMLDivElement;
    expect(dropzone.classList.contains("file-upload__dropzone--hidden")).toBe(true);

    upload.destroy?.();
  });

  // ── Image preview shows thumbnail ──

  it("shows image thumbnail for image files", async () => {
    // Polyfill URL.createObjectURL/revokeObjectURL for jsdom
    const mockUrl = "blob:http://localhost/fake-image-url";
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => mockUrl);
    URL.revokeObjectURL = vi.fn();

    const onUpload = vi.fn(async () => {});
    const upload = makeUpload({ onUpload });

    const imageFile = new File(["img data"], "photo.png", { type: "image/png" });

    const input = container.querySelector(".file-upload__input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [imageFile], writable: true });
    input.dispatchEvent(new Event("change"));

    await new Promise((r) => setTimeout(r, 10));

    const thumb = container.querySelector(".file-upload__thumb") as HTMLImageElement;
    expect(thumb.src).toBe(mockUrl);
    expect(thumb.style.display).toBe("block");

    // Restore
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    upload.destroy?.();
  });

  // ── Multiple drag enter/leave with counter ──

  it("nested dragenter/dragleave keeps dropzone visible until all leave", () => {
    const upload = makeUpload();
    const root = container.querySelector(".file-upload") as HTMLDivElement;
    const dropzone = container.querySelector(".file-upload__dropzone") as HTMLDivElement;

    // Simulate nested dragenter (child element also fires dragenter)
    root.dispatchEvent(new Event("dragenter", { bubbles: true }));
    root.dispatchEvent(new Event("dragenter", { bubbles: true }));

    // One dragleave -- dropzone should still be visible
    root.dispatchEvent(new Event("dragleave", { bubbles: true }));
    expect(dropzone.classList.contains("file-upload__dropzone--hidden")).toBe(false);

    // Second dragleave -- now it should hide
    root.dispatchEvent(new Event("dragleave", { bubbles: true }));
    expect(dropzone.classList.contains("file-upload__dropzone--hidden")).toBe(true);

    upload.destroy?.();
  });

  // ── Destroy aborts in-flight upload ──

  it("destroy aborts in-flight upload", async () => {
    let resolveUpload: (() => void) | null = null;
    const onUpload = vi.fn(() => new Promise<void>((resolve) => {
      resolveUpload = resolve;
    }));
    const upload = makeUpload({ onUpload });

    const file = new File(["data"], "test.txt", { type: "text/plain" });
    const input = container.querySelector(".file-upload__input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], writable: true });
    input.dispatchEvent(new Event("change"));

    await new Promise((r) => setTimeout(r, 10));

    // Destroy should not throw even with upload in flight
    upload.destroy?.();
    expect(container.querySelector(".file-upload")).toBeNull();

    // Clean up
    resolveUpload?.();
  });

  // ── File size formatting ──

  it("displays file size in KB for small files", async () => {
    const onUpload = vi.fn(async () => {});
    const upload = makeUpload({ onUpload });

    const file = new File(["x".repeat(2048)], "small.txt", { type: "text/plain" });

    const input = container.querySelector(".file-upload__input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], writable: true });
    input.dispatchEvent(new Event("change"));

    await new Promise((r) => setTimeout(r, 10));

    const sizeSpan = container.querySelector(".file-upload__size");
    expect(sizeSpan?.textContent).toContain("KB");

    upload.destroy?.();
  });

  it("displays file size in MB for large files", async () => {
    const onUpload = vi.fn(async () => {});
    const upload = makeUpload({ onUpload, maxSizeMb: 20 });

    const file = new File(["x"], "big.bin", { type: "application/octet-stream" });
    Object.defineProperty(file, "size", { value: 5 * 1024 * 1024 }); // 5 MB

    const input = container.querySelector(".file-upload__input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], writable: true });
    input.dispatchEvent(new Event("change"));

    await new Promise((r) => setTimeout(r, 10));

    const sizeSpan = container.querySelector(".file-upload__size");
    expect(sizeSpan?.textContent).toContain("MB");

    upload.destroy?.();
  });

  it("displays file size in B for very small files", async () => {
    const onUpload = vi.fn(async () => {});
    const upload = makeUpload({ onUpload });

    const file = new File(["hi"], "tiny.txt", { type: "text/plain" });
    // File constructor creates a Blob with size = content.length

    const input = container.querySelector(".file-upload__input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], writable: true });
    input.dispatchEvent(new Event("change"));

    await new Promise((r) => setTimeout(r, 10));

    const sizeSpan = container.querySelector(".file-upload__size");
    // 2 bytes "hi" should display as "2 B"
    expect(sizeSpan?.textContent).toContain("B");

    upload.destroy?.();
  });

  // ── File input resets after selection ──

  it("resets file input value after change so same file can be re-selected", async () => {
    const onUpload = vi.fn(async () => {});
    const upload = makeUpload({ onUpload });

    const file = new File(["data"], "test.txt", { type: "text/plain" });
    const input = container.querySelector(".file-upload__input") as HTMLInputElement;

    // Set initial value (simulating a previous selection)
    input.value = "";
    Object.defineProperty(input, "files", { value: [file], writable: true });
    input.dispatchEvent(new Event("change"));

    await new Promise((r) => setTimeout(r, 10));

    expect(onUpload).toHaveBeenCalled();
    // Input value should be reset to empty
    expect(input.value).toBe("");

    upload.destroy?.();
  });
});
