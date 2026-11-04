import { describe, it, expect, vi, afterEach } from "vitest";
import * as mocks from "../../helpers/messageInputMocks";
import { createMessageInput } from "@components/MessageInput";
import { authStore } from "@stores/auth.store";
import {
  makeOptions,
  makeOversizedFile,
  mountMessageInput,
  selectFiles,
  useMessageInputContainer,
  pasteFile,
} from "../../helpers/messageInputHarness";

vi.mock("@components/EmojiPicker", () => mocks.emojiPickerMock());
vi.mock("@components/GifPicker", () => mocks.gifPickerMock());

describe("MessageInput", () => {
  let container: HTMLDivElement;
  useMessageInputContainer((el) => {
    container = el;
  });

  it("file upload shows preview and sends attachment ID with message", async () => {
    const uploadResult = { id: "srv-123", url: "http://server/file.png", filename: "file.png" };
    const onUploadFile = vi.fn(async () => uploadResult);
    const { opts, comp } = mountMessageInput(container, { onUploadFile });

    // Simulate file selection via the hidden input
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).not.toBeNull();

    const testFile = new File(["image data"], "test.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [testFile], writable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    // Wait for the async upload to complete
    await vi.waitFor(() => {
      expect(onUploadFile).toHaveBeenCalledWith(
        testFile,
        expect.any(AbortSignal),
        expect.any(Function),
      );
    });

    // Preview bar should be visible
    const previewBar = container.querySelector(".attachment-preview-bar");
    expect(previewBar!.classList.contains("visible")).toBe(true);

    // Now send a message -- should include the attachment ID
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "with attachment";
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();

    expect(opts.onSend).toHaveBeenCalledWith(
      "with attachment",
      null,
      ["srv-123"],
      [expect.objectContaining({ id: "srv-123" })],
      false,
    );

    comp.destroy?.();
  });

  it("rejects file exceeding 100 MB size limit", async () => {
    const onUploadFile = vi.fn(async () => ({ id: "x", url: "x", filename: "x" }));
    const { comp } = mountMessageInput(container, { onUploadFile });

    // Create a file > 100MB
    const bigFile = makeOversizedFile();

    selectFiles(container, [bigFile]);

    // Give async handlers a tick
    await new Promise((r) => setTimeout(r, 10));

    // Upload should NOT have been called
    expect(onUploadFile).not.toHaveBeenCalled();

    // Error message should be displayed
    const error = container.querySelector(".attachment-upload-error");
    expect(error).not.toBeNull();
    expect(error!.textContent).toContain("too large");

    comp.destroy?.();
  });

  it("upload error makes the (initially hidden) preview bar visible", async () => {
    const onUploadFile = vi.fn(async () => ({ id: "x", url: "x", filename: "x" }));
    const { comp } = mountMessageInput(container, { onUploadFile });

    // Nothing queued yet, so the preview bar starts without the "visible"
    // class -- app.css only shows it via .visible.
    const previewBar = container.querySelector(".attachment-preview-bar");
    expect(previewBar!.classList.contains("visible")).toBe(false);

    const bigFile = makeOversizedFile();

    selectFiles(container, [bigFile]);

    await new Promise((r) => setTimeout(r, 10));

    expect(container.querySelector(".attachment-upload-error")).not.toBeNull();
    expect(previewBar!.classList.contains("visible")).toBe(true);

    comp.destroy?.();
  });

  it("keeps the error until the user edits, then clears and hides the preview bar (A11Y-05)", async () => {
    vi.useFakeTimers();
    const onUploadFile = vi.fn(async () => ({ id: "x", url: "x", filename: "x" }));
    const { comp } = mountMessageInput(container, { onUploadFile });

    const bigFile = makeOversizedFile();
    selectFiles(container, [bigFile]);

    await vi.advanceTimersByTimeAsync(10);
    const previewBar = container.querySelector(".attachment-preview-bar");
    expect(previewBar!.classList.contains("visible")).toBe(true);

    // A refusal is not a 4s toast: it survives well past the old window so
    // the user can read it.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(container.querySelector(".attachment-upload-error")).not.toBeNull();
    expect(previewBar!.classList.contains("visible")).toBe(true);

    // Editing the textarea is the user acting on it -- the line clears.
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(container.querySelector(".attachment-upload-error")).toBeNull();
    expect(previewBar!.classList.contains("visible")).toBe(false);

    vi.useRealTimers();
    comp.destroy?.();
  });

  it("refuses a file over the server's advertised limit before uploading, naming the limit", async () => {
    authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 10 * 1024 * 1024 } }));
    try {
      const onUploadFile = vi.fn(async () => ({ id: "x", url: "x", filename: "x" }));
      const comp = createMessageInput(makeOptions({ onUploadFile }));
      comp.mount(container);

      const file = new File(["x"], "clip.mp4", { type: "video/mp4" });
      Object.defineProperty(file, "size", { value: 11 * 1024 * 1024 });
      selectFiles(container, [file]);
      await new Promise((r) => setTimeout(r, 10));

      expect(onUploadFile).not.toHaveBeenCalled();
      const error = container.querySelector(".attachment-upload-error");
      expect(error!.textContent).toContain("clip.mp4 exceeds 10 MB limit");

      comp.destroy?.();
    } finally {
      authStore.setState((s) => ({ ...s, uploadPolicy: null }));
    }
  });

  describe("server file-type policy", () => {
    async function pick(name: string) {
      const onUploadFile = vi.fn(async () => ({ id: "x", url: "x", filename: name }));
      const comp = createMessageInput(makeOptions({ onUploadFile }));
      comp.mount(container);
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, "files", {
        value: [new File(["x"], name, { type: "" })],
        writable: true,
      });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
      const error = container.querySelector(".attachment-upload-error")?.textContent ?? null;
      comp.destroy?.();
      return { onUploadFile, error };
    }

    afterEach(() => authStore.setState((s) => ({ ...s, uploadPolicy: null })));

    it("refuses a blocked final extension before uploading, however it is spelled", async () => {
      authStore.setState((s) => ({
        ...s,
        uploadPolicy: { max_upload_bytes: 10 * 1024 * 1024, blocked_extensions: ["bat", "ps1"] },
      }));
      for (const name of ["cleanup.BAT", "report.pdf.bat", "photo.jpg.ps1", "run.bat. "]) {
        const { onUploadFile, error } = await pick(name);
        expect(onUploadFile, name).not.toHaveBeenCalled();
        expect(error, name).toMatch(/this server doesn't allow \.(bat|ps1) files$/);
        expect(error, name).toContain(name);
      }
      for (const name of ["notes.txt", "invoice.ps1.txt", "www.amazon.bat.png"]) {
        expect((await pick(name)).onUploadFile, name).toHaveBeenCalled();
      }
    });

    it("in allow-only mode refuses anything not listed, including no extension", async () => {
      authStore.setState((s) => ({
        ...s,
        uploadPolicy: { max_upload_bytes: 10 * 1024 * 1024, allowed_extensions: ["png", "pdf"] },
      }));
      expect((await pick("clip.mp4")).error).toBe(
        "clip.mp4 can't be uploaded: this server doesn't allow .mp4 files",
      );
      expect((await pick("README")).error).toBe(
        "README can't be uploaded: this server only accepts certain file types",
      );
      expect((await pick("Photo.PNG")).onUploadFile).toHaveBeenCalled();
    });

    it("uploads any type when the server sends no lists (an older server)", async () => {
      authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 10 * 1024 * 1024 } }));
      expect((await pick("cleanup.bat")).onUploadFile).toHaveBeenCalled();
    });
  });

  it("uploads a file above 100 MB when the server advertises a larger limit", async () => {
    authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 150 * 1024 * 1024 } }));
    try {
      const onUploadFile = vi.fn(async () => ({ id: "x", url: "x", filename: "big.bin" }));
      const comp = createMessageInput(makeOptions({ onUploadFile }));
      comp.mount(container);

      const file = new File(["x"], "big.bin", { type: "application/octet-stream" });
      Object.defineProperty(file, "size", { value: 120 * 1024 * 1024 });
      selectFiles(container, [file]);

      await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalled());
      comp.destroy?.();
    } finally {
      authStore.setState((s) => ({ ...s, uploadPolicy: null }));
    }
  });

  it("disables attaching when the server advertises uploads disabled (0), even after mount", async () => {
    const onUploadFile = vi.fn(async () => ({ id: "x", url: "x", filename: "p.png" }));
    const comp = createMessageInput(makeOptions({ onUploadFile }));
    comp.mount(container);
    const attachBtn = container.querySelector(".attach-btn") as HTMLButtonElement;
    expect(attachBtn.disabled).toBe(false);
    try {
      authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 0 } }));
      authStore.flush();

      expect(attachBtn.disabled).toBe(true);
      expect(attachBtn.title).toBe("Uploads are disabled on this server");

      comp.openFilePicker();
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, "files", {
        value: [new File(["x"], "a.bin", { type: "application/octet-stream" })],
        writable: true,
      });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      pasteFile(container, new File(["img"], "p.png", { type: "image/png" }));
      await new Promise((r) => setTimeout(r, 10));

      expect(onUploadFile).not.toHaveBeenCalled();
      expect(container.querySelectorAll(".attachment-preview-item").length).toBe(0);
      expect(container.querySelector(".attachment-upload-error")!.textContent).toBe(
        "Uploads are disabled on this server",
      );

      // A later auth_ok that re-enables uploads re-enables the control.
      authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 10 * 1024 * 1024 } }));
      authStore.flush();
      expect(attachBtn.disabled).toBe(false);
      expect(attachBtn.title).toBe("");
    } finally {
      authStore.setState((s) => ({ ...s, uploadPolicy: null }));
      comp.destroy?.();
    }
  });

  it("keeps the attach button disabled while gated even if uploads are enabled", () => {
    const comp = createMessageInput(
      makeOptions({ onUploadFile: vi.fn(async () => ({ id: "x", url: "x", filename: "x" })) }),
    );
    comp.mount(container);
    comp.setDisabled("Not connected");
    const attachBtn = container.querySelector(".attach-btn") as HTMLButtonElement;
    expect(attachBtn.disabled).toBe(true);
    comp.setDisabled(null);
    expect(attachBtn.disabled).toBe(false);
    comp.destroy?.();
  });

  // D1 (a): any type the server accepts can be attached; the server stays
  // authoritative and refuses its own blocked types.
  it("uploads a file of a type outside the old allowlist", async () => {
    const onUploadFile = vi.fn(async () => ({ id: "x", url: "x", filename: "a.7z" }));
    const comp = createMessageInput(makeOptions({ onUploadFile }));
    comp.mount(container);

    const file = new File(["7z"], "a.7z", { type: "application/x-7z-compressed" });
    selectFiles(container, [file]);

    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalled());
    expect(container.querySelector(".attachment-upload-error")).toBeNull();
    comp.destroy?.();
  });

  // SRV-05 (client): removing an in-flight attachment must abort its upload
  // and free Send immediately, instead of leaving a doomed request running
  // and the composer blocked on it.
  it("aborts an in-flight upload when its preview is removed", async () => {
    let capturedSignal: AbortSignal | undefined;
    const onUploadFile = vi.fn(
      (_file: File, signal?: AbortSignal) =>
        new Promise<{ id: string; url: string; filename: string }>((_resolve, reject) => {
          capturedSignal = signal;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const { opts, comp } = mountMessageInput(container, { onUploadFile });

    const file = new File(["data"], "big.pdf", { type: "application/pdf" });
    selectFiles(container, [file]);

    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledOnce());
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    (container.querySelector("[data-testid='attachment-remove']") as HTMLButtonElement).click();

    // The request is cancelled and its preview is gone.
    expect(capturedSignal!.aborted).toBe(true);
    expect(container.querySelector(".attachment-preview-item")).toBeNull();

    // Send must be free immediately: an empty-edit send is refused for being
    // empty, not for uploads still pending.
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "hello";
    (container.querySelector(".send-btn") as HTMLButtonElement).click();
    expect(opts.onSend).toHaveBeenCalledWith("hello", null, [], [], false);

    comp.destroy?.();
  });

  it("removing a finished upload leaves only the in-flight one in the queued send", async () => {
    const onUploadFile = vi
      .fn<
        (file: File, signal?: AbortSignal) => Promise<{ id: string; url: string; filename: string }>
      >()
      .mockResolvedValueOnce({ id: "srv-a", url: "/a", filename: "a.pdf" })
      .mockImplementationOnce(() => new Promise(() => {}));
    const { opts, comp } = mountMessageInput(container, { onUploadFile });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const attach = (name: string): void => {
      Object.defineProperty(fileInput, "files", {
        value: [new File(["data"], name, { type: "application/pdf" })],
        configurable: true,
      });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    };

    attach("a.pdf");
    await vi.waitFor(() =>
      expect(container.querySelector(".attachment-preview-item.uploading")).toBeNull(),
    );
    (container.querySelector("[data-testid='attachment-remove']") as HTMLButtonElement).click();

    attach("b.pdf");
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(2));

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "hello";
    (container.querySelector(".send-btn") as HTMLButtonElement).click();
    // 3A-9: the removed upload's id is never sent; only b.pdf is queued.
    expect(opts.onSend).toHaveBeenCalledOnce();
    const call = vi.mocked(opts.onSend).mock.calls[0]!;
    expect(call.slice(0, 5)).toEqual(["hello", null, [], [], false]);
    expect(call[5]).toEqual([
      {
        filename: "b.pdf",
        file: expect.any(File),
        upload: expect.objectContaining({ filename: "b.pdf" }),
      },
    ]);
    expect(container.querySelector(".attachment-preview-item")).toBeNull();

    comp.destroy?.();
  });

  it("shows no error when an upload is aborted by the user", async () => {
    const onUploadFile = vi.fn(
      (_file: File, signal?: AbortSignal) =>
        new Promise<{ id: string; url: string; filename: string }>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const { comp } = mountMessageInput(container, { onUploadFile });

    const file = new File(["data"], "big.pdf", { type: "application/pdf" });
    selectFiles(container, [file]);

    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledOnce());
    (container.querySelector("[data-testid='attachment-remove']") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));

    // A deliberate cancel is not a failure: no refusal line.
    expect(container.querySelector(".attachment-upload-error")).toBeNull();

    comp.destroy?.();
  });

  it("shows upload error when onUploadFile rejects", async () => {
    const onUploadFile = vi.fn(async () => {
      throw new Error("Server exploded");
    });
    const { comp } = mountMessageInput(container, { onUploadFile });

    const file = new File(["data"], "doc.pdf", { type: "application/pdf" });
    selectFiles(container, [file]);

    // Wait for the async rejection
    await vi.waitFor(() => {
      const error = container.querySelector(".attachment-upload-error");
      expect(error).not.toBeNull();
      expect(error!.textContent).toContain("Server exploded");
    });

    comp.destroy?.();
  });

  it("queues the send while uploads are still in flight", async () => {
    // Create an upload that stays pending until the test resolves it
    let resolveUpload: ((v: { id: string; url: string; filename: string }) => void) | null = null;
    const onUploadFile = vi.fn(
      () =>
        new Promise<{ id: string; url: string; filename: string }>((res) => {
          resolveUpload = res;
        }),
    );
    const { opts, comp } = mountMessageInput(container, { onUploadFile });

    const file = new File(["data"], "doc.txt", { type: "text/plain" });
    selectFiles(container, [file]);

    // The upload is in flight but not resolved
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "trying to send";
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();

    // 3A-9: the send goes to the host as a queued one, the composer is empty
    // at once, and nothing is refused.
    expect(opts.onSend).toHaveBeenCalledOnce();
    const call = vi.mocked(opts.onSend).mock.calls[0]!;
    expect(call.slice(0, 5)).toEqual(["trying to send", null, [], [], false]);
    expect(call[5]).toEqual([
      { filename: "doc.txt", file, upload: expect.objectContaining({ filename: "doc.txt" }) },
    ]);
    expect(textarea.value).toBe("");
    expect(container.querySelector(".attachment-preview-item")).toBeNull();
    expect(container.querySelector(".attachment-upload-error")?.textContent ?? "").toBe("");

    // Once the upload resolves the composer sends nothing more and shows no error.
    resolveUpload!({ id: "done", url: "http://x", filename: "doc.txt" });
    await new Promise((r) => setTimeout(r, 10));
    expect(opts.onSend).toHaveBeenCalledOnce();
    expect(container.querySelector(".attachment-upload-error")?.textContent ?? "").toBe("");

    comp.destroy?.();
  });

  it("remove button removes attachment preview while upload is pending", async () => {
    // Use a long-running upload so we can click remove while it's still pending
    let resolveUpload: ((v: { id: string; url: string; filename: string }) => void) | null = null;
    const onUploadFile = vi.fn(
      () =>
        new Promise<{ id: string; url: string; filename: string }>((res) => {
          resolveUpload = res;
        }),
    );
    const { comp } = mountMessageInput(container, { onUploadFile });

    const file = new File(["text"], "file.txt", { type: "text/plain" });
    selectFiles(container, [file]);

    // Wait for the preview to appear (upload started but not resolved)
    await vi.waitFor(() => {
      expect(onUploadFile).toHaveBeenCalled();
    });

    // Preview bar should be visible with the uploading item
    const previewBar = container.querySelector(".attachment-preview-bar");
    expect(previewBar!.classList.contains("visible")).toBe(true);

    // Remove the attachment while upload is still pending (tempId still matches)
    const removeBtn = container.querySelector('[data-testid="attachment-remove"]') as HTMLElement;
    expect(removeBtn).not.toBeNull();
    removeBtn.click();

    // Preview bar should lose visible class (all attachments removed from list)
    expect(previewBar!.classList.contains("visible")).toBe(false);

    // The preview item DOM element should be removed from the bar
    expect(previewBar!.querySelector(".attachment-preview-item")).toBeNull();

    // Clean up the pending promise
    resolveUpload!({ id: "done", url: "http://x", filename: "file.txt" });
    await new Promise((r) => setTimeout(r, 10));

    comp.destroy?.();
  });

  it("remove button removes attachment preview after the upload has completed", async () => {
    const uploadResult = { id: "srv-123", url: "http://server/file.png", filename: "file.png" };
    const onUploadFile = vi.fn(async () => uploadResult);
    const { opts, comp } = mountMessageInput(container, { onUploadFile });

    const testFile = new File(["image data"], "test.png", { type: "image/png" });
    selectFiles(container, [testFile]);

    // Wait for the upload to resolve — the entry's id is now the server id,
    // not the tempId the remove button was created with.
    await vi.waitFor(() => {
      expect(onUploadFile).toHaveBeenCalledWith(
        testFile,
        expect.any(AbortSignal),
        expect.any(Function),
      );
    });
    const previewBar = container.querySelector(".attachment-preview-bar");
    await vi.waitFor(() => {
      expect(previewBar!.querySelector(".uploading")).toBeNull();
    });

    const removeBtn = container.querySelector('[data-testid="attachment-remove"]') as HTMLElement;
    expect(removeBtn).not.toBeNull();
    removeBtn.click();

    expect(previewBar!.classList.contains("visible")).toBe(false);
    expect(previewBar!.querySelector(".attachment-preview-item")).toBeNull();

    // Sending now must not include the removed attachment.
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "no attachment";
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();
    expect(opts.onSend).toHaveBeenCalledWith("no attachment", null, [], [], false);

    comp.destroy?.();
  });

  // ── Reply close button ──

  it("clicking reply close button hides reply bar", () => {
    const { comp } = mountMessageInput(container);

    comp.setReplyTo(42, "replyuser");
    const replyBar = container.querySelector(".reply-bar") as HTMLDivElement;
    expect(replyBar.classList.contains("visible")).toBe(true);

    const closeBtn = replyBar.querySelector(".reply-close") as HTMLElement;
    closeBtn.click();

    expect(replyBar.classList.contains("visible")).toBe(false);

    comp.destroy?.();
  });

  // ── Accessible names for icon-only composer controls (B9-22) ──

  it("names the reply close button", () => {
    const { comp } = mountMessageInput(container);

    comp.setReplyTo(1, "x");

    const replyClose = container.querySelector(".reply-bar .reply-close")!;
    expect(replyClose.getAttribute("aria-label")).toBe("Cancel reply");

    comp.destroy?.();
  });

  it("names the attachment remove button with its filename", async () => {
    const onUploadFile = vi.fn(async () => ({
      id: "srv-1",
      url: "http://x/f.png",
      filename: "f.png",
    }));
    const comp = createMessageInput(makeOptions({ onUploadFile }));
    comp.mount(container);

    const file = new File(["x"], "photo.png", { type: "image/png" });
    selectFiles(container, [file]);

    await vi.waitFor(() => {
      const btn = container.querySelector('[data-testid="attachment-remove"]');
      expect(btn).not.toBeNull();
      expect(btn!.getAttribute("aria-label")).toBe("Remove attachment photo.png");
    });

    comp.destroy?.();
  });

  // ── Textarea auto-resize ──

  it("textarea height adjusts on input (auto-resize)", () => {
    const { comp } = mountMessageInput(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    // After mount, textarea should have style.height set
    // Just verify input event triggers without error (auto-resize runs)
    textarea.value = "Line 1\nLine 2\nLine 3";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    // Height should be set (not "auto")
    expect(textarea.style.height).not.toBe("");

    comp.destroy?.();
  });

  // ── Emoji picker ──

  it("clicking emoji button opens emoji picker", async () => {
    const { comp } = mountMessageInput(container);

    const emojiBtn = container.querySelector(".emoji-btn") as HTMLElement;
    emojiBtn.click();
    await vi.dynamicImportSettled();

    const picker = container.querySelector(".emoji-picker");
    expect(picker).not.toBeNull();

    comp.destroy?.();
  });
});
