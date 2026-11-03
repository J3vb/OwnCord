import { describe, it, expect, vi, afterEach } from "vitest";
import * as mocks from "../../helpers/messageInputMocks";
import { usePhone } from "../../helpers/phoneMedia";
import { closeBottomSheet } from "@lib/ui/bottomSheet";
import { authStore } from "@stores/auth.store";
import { mountMessageInput, useMessageInputContainer } from "../../helpers/messageInputHarness";
import { attachSheetEl, settleHistory } from "../../helpers/composerSheets";

vi.mock("@components/EmojiPicker", () => mocks.emojiPickerMock());
vi.mock("@components/GifPicker", () => mocks.gifPickerMock());

const sheet = attachSheetEl;
const tile = (source: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`[data-testid="attach-sheet-${source}"]`)!;

function inputOf(container: HTMLElement, source: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`input[data-attach-source="${source}"]`)!;
}

function choose(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", { value: files, writable: true, configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("MessageInput attach sheet", () => {
  let container: HTMLDivElement;
  useMessageInputContainer((el) => {
    container = el;
  });

  afterEach(async () => {
    closeBottomSheet();
    await settleHistory();
    vi.unstubAllGlobals();
  });

  function mountUploader() {
    const onUploadFile = vi.fn(async (file: File) => ({
      id: `srv-${file.name}`,
      url: `http://server/${file.name}`,
      filename: file.name,
    }));
    const { comp } = mountMessageInput(container, { onUploadFile });
    const attachBtn = container.querySelector<HTMLButtonElement>(".attach-btn")!;
    return { comp, onUploadFile, attachBtn };
  }

  it("gives each source its own input, with the Files one first", () => {
    const { comp } = mountUploader();
    const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="file"]')];
    expect(inputs.map((i) => i.dataset.attachSource)).toEqual(["files", "camera", "gallery"]);

    const camera = inputOf(container, "camera");
    expect(camera.accept).toBe("image/*");
    expect(camera.getAttribute("capture")).toBe("environment");
    expect(camera.multiple).toBe(false);
    const gallery = inputOf(container, "gallery");
    expect(gallery.accept).toBe("image/*,video/*");
    expect(gallery.multiple).toBe(true);
    const files = inputOf(container, "files");
    expect(files.hasAttribute("accept")).toBe(false);
    expect(files.multiple).toBe(true);
    comp.destroy?.();
  });

  it("opens the file picker directly off the phone layout", () => {
    const { comp, attachBtn } = mountUploader();
    const click = vi.spyOn(inputOf(container, "files"), "click").mockImplementation(() => {});
    attachBtn.click();
    expect(sheet()).toBeNull();
    expect(click).toHaveBeenCalledOnce();
    comp.destroy?.();
  });

  describe("on a phone", () => {
    it("opens a sheet with Take photo, Gallery and Files", () => {
      usePhone();
      const { comp, attachBtn } = mountUploader();
      attachBtn.click();
      expect(sheet()).not.toBeNull();
      const labels = [...sheet()!.querySelectorAll(".attach-sheet-tile")].map((b) =>
        b.textContent?.trim(),
      );
      expect(labels).toEqual(["Take photo", "Gallery", "Files"]);
      comp.destroy?.();
    });

    it.each(["camera", "gallery", "files"])(
      "the %s tile closes the sheet and opens its own input once",
      (source) => {
        usePhone();
        const { comp, attachBtn } = mountUploader();
        const clicks = Object.fromEntries(
          ["camera", "gallery", "files"].map((s) => [
            s,
            vi.spyOn(inputOf(container, s), "click").mockImplementation(() => {}),
          ]),
        );
        attachBtn.click();
        const btn = tile(source);
        btn.click();
        btn.click();
        expect(sheet()).toBeNull();
        for (const [s, spy] of Object.entries(clicks)) {
          expect(spy).toHaveBeenCalledTimes(s === source ? 1 : 0);
        }
        comp.destroy?.();
      },
    );

    it("uploads a photo from the camera and several gallery picks", async () => {
      usePhone();
      const { comp, onUploadFile } = mountUploader();
      const photo = new File(["jpg"], "photo.jpg", { type: "image/jpeg" });
      const a = new File(["a"], "a.png", { type: "image/png" });
      const b = new File(["b"], "b.mp4", { type: "video/mp4" });

      choose(inputOf(container, "camera"), [photo]);
      choose(inputOf(container, "gallery"), [a, b]);

      await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(3));
      expect(onUploadFile.mock.calls.map((c) => c[0])).toEqual([photo, a, b]);
      expect(inputOf(container, "gallery").value).toBe("");
      expect(container.querySelectorAll(".attachment-preview-item").length).toBe(3);
      comp.destroy?.();
    });

    it("opens no picker when uploads were turned off while the sheet was open", () => {
      usePhone();
      const { comp, attachBtn } = mountUploader();
      const click = vi.spyOn(inputOf(container, "camera"), "click").mockImplementation(() => {});
      attachBtn.click();
      try {
        authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 0 } }));
        authStore.flush();
        tile("camera").click();
        expect(click).not.toHaveBeenCalled();
        expect(sheet()).toBeNull();
      } finally {
        authStore.setState((s) => ({ ...s, uploadPolicy: null }));
        comp.destroy?.();
      }
    });

    it("closes the sheet when the composer goes away", () => {
      usePhone();
      const { comp, attachBtn } = mountUploader();
      attachBtn.click();
      expect(sheet()).not.toBeNull();
      comp.destroy?.();
      expect(sheet()).toBeNull();
    });

    it("keeps the keyboard shortcut on the file picker", () => {
      usePhone();
      const { comp } = mountUploader();
      const click = vi.spyOn(inputOf(container, "files"), "click").mockImplementation(() => {});
      comp.openFilePicker();
      expect(sheet()).toBeNull();
      expect(click).toHaveBeenCalledOnce();
      comp.destroy?.();
    });
  });
});
