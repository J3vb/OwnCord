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
});
