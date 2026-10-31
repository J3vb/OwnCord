// Per-attachment determinate upload progress (B11b). The composer shows a
// percentage and a fill for each chip while its upload is in flight, driven by
// the `onProgress` callback the upload handler reports.
import { describe, it, expect, vi } from "vitest";

import * as mocks from "../helpers/messageInputMocks";
vi.mock("@components/EmojiPicker", () => mocks.emojiPickerMock());
vi.mock("@components/GifPicker", () => mocks.gifPickerMock());

import { createMessageInput } from "@components/MessageInput";
import { useMountContainer } from "../helpers/mountContainer";
import { controlledUpload, makeOptions, queueFile } from "../helpers/messageInputHarness";

describe("MessageInput upload progress", () => {
  let container: HTMLDivElement;
  useMountContainer((mounted) => {
    container = mounted;
  });

  it("shows determinate progress from a progress callback while the upload runs", async () => {
    const up = controlledUpload();
    const onUploadFile = up.fn;
    const comp = createMessageInput(makeOptions({ onUploadFile }));
    comp.mount(container);

    queueFile(container, new File(["x"], "a.png", { type: "image/png" }));
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalled());

    up.progress(0.25);
    const bar = container.querySelector("progress") as HTMLProgressElement;
    await vi.waitFor(() => expect(bar?.value).toBeCloseTo(0.25));

    up.resolve({ id: "srv-1", url: "/f/1", filename: "a.png" });
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    comp.destroy?.();
  });

  it("keeps the bar indeterminate until the first progress tick", async () => {
    const onUploadFile = vi.fn(() => new Promise<never>(() => {}));
    const comp = createMessageInput(makeOptions({ onUploadFile }));
    comp.mount(container);

    queueFile(container, new File(["x"], "a.png", { type: "image/png" }));
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalled());
    const bar = container.querySelector("progress") as HTMLProgressElement;
    expect(bar).not.toBeNull();
    // No `value` attribute is what makes a <progress> indeterminate.
    expect(bar.hasAttribute("value")).toBe(false);
    comp.destroy?.();
  });
});
