// Voice messages in the composer (WP 8.9): the mic button's gates, the
// record -> upload -> send path, and the two edge cases the design pins:
// a failed upload keeps the clip (Retry, sent once) and a destroyed composer
// stops the microphone and sends nothing.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));
vi.mock("@components/GifPicker", () => ({
  createGifPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));

import { createMessageInput, type MessageInputOptions } from "@components/MessageInput";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/serverCapabilities";
import type { VoiceUploadMeta } from "@lib/types";
import { ATTACHMENT_TTL_MS } from "../../src/features/messaging/attachmentTtl";
import { authStore } from "@stores/auth.store";
import { FakeAudioContext, FakeMediaRecorder, FakeStream, resetFakes } from "../helpers/voiceFakes";

type Uploaded = { id: string; url: string; filename: string };

let clock = 0;
let stream: FakeStream;
let container: HTMLDivElement;
const made: Array<{ destroy?: () => void }> = [];

/** Every composer built here is destroyed in afterEach (its drop overlay listens on document). */
function mountComposer(overrides: Partial<MessageInputOptions> = {}) {
  const comp = createMessageInput(makeOptions(overrides));
  made.push(comp);
  comp.mount(container);
  return comp;
}
const mediaDevices = { getUserMedia: vi.fn() };

function makeOptions(overrides: Partial<MessageInputOptions> = {}): MessageInputOptions {
  return {
    channelId: 1,
    channelName: "general",
    onSend: vi.fn(),
    onTyping: vi.fn(),
    onUploadFile: vi.fn(async (file: File) => ({ id: "up-1", url: "/f/1", filename: file.name })),
    ...overrides,
  };
}

const q = <T extends Element>(sel: string): T | null => container.querySelector<T>(sel);
const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

async function record(ms = 2_000): Promise<void> {
  q<HTMLButtonElement>('[data-testid="voice-mic-btn"]')!.click();
  await flush();
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

beforeAll(async () => {
  // The mic click loads the recorder lazily; warm it so the import settles in a microtask.
  await import("../../src/features/voice-messages/voiceComposer");
});

beforeEach(() => {
  vi.useFakeTimers();
  resetFakes();
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  stream = new FakeStream();
  mediaDevices.getUserMedia.mockReset().mockImplementation(async () => stream);
  Object.defineProperty(navigator, "mediaDevices", { value: mediaDevices, configurable: true });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  applyReadyCapabilities({ voice_messages: true });
  authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 10 * 1024 * 1024 } }));
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  for (const comp of made.splice(0)) comp.destroy?.();
  container.remove();
  resetServerCapabilities();
  authStore.setState((s) => ({ ...s, uploadPolicy: null }));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("mic button gates", () => {
  it("is hidden when the server does not advertise voice_messages", () => {
    resetServerCapabilities();
    applyReadyCapabilities({});
    mountComposer();
    expect(q<HTMLButtonElement>('[data-testid="voice-mic-btn"]')?.hidden).toBe(true);
  });

  it("is hidden when uploads are disabled on the server", () => {
    authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 0 } }));
    mountComposer();
    expect(q<HTMLButtonElement>('[data-testid="voice-mic-btn"]')?.hidden).toBe(true);
  });

  it("is absent without an upload handler or in a text-only composer", () => {
    mountComposer({ onUploadFile: undefined });
    expect(q('[data-testid="voice-mic-btn"]')).toBeNull();
    container.replaceChildren();
    mountComposer({ noAttach: true });
    expect(q('[data-testid="voice-mic-btn"]')).toBeNull();
  });

  it("shows when uploads and the capability are there, and disables with the composer", () => {
    const comp = mountComposer();
    const mic = q<HTMLButtonElement>('[data-testid="voice-mic-btn"]')!;
    expect(mic.hidden).toBe(false);
    expect(mic.disabled).toBe(false);
    comp.setDisabled("Offline");
    expect(mic.disabled).toBe(true);
    comp.setDisabled(null);
    expect(mic.disabled).toBe(false);
  });
});

describe("recording and sending", () => {
  it("uploads with the voice params, then sends one attachment and no text", async () => {
    const onUploadFile = vi.fn(
      async (
        file: File,
        _signal?: AbortSignal,
        _p?: unknown,
        _voice?: VoiceUploadMeta,
      ): Promise<Uploaded> => ({
        id: "up-9",
        url: "/f/9",
        filename: file.name,
      }),
    );
    const onSend = vi.fn();
    const comp = mountComposer({ onUploadFile, onSend });
    await record(2_000);
    expect(q('[data-testid="voice-bar"]')).not.toBeNull();
    expect(q(".message-input-wrap")?.classList.contains("voice-active")).toBe(true);

    q<HTMLButtonElement>('[data-testid="voice-send"]')!.click();
    await flush();

    expect(onUploadFile).toHaveBeenCalledTimes(1);
    const [file, , , voice] = onUploadFile.mock.calls[0]!;
    expect(file.name).toBe("voice-message.webm");
    expect(voice?.durationMs).toBe(2_000);
    expect(voice?.waveform).toMatch(/^[A-Za-z0-9_-]{1,342}$/);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(
      "",
      null,
      ["up-9"],
      [expect.objectContaining({ id: "up-9", filename: "voice-message.webm" })],
      false,
    );
    expect(q('[data-testid="voice-bar"]')).toBeNull();
    expect(stream.allStopped).toBe(true);
  });

  it("keeps the reply target when sending", async () => {
    const onSend = vi.fn();
    const comp = mountComposer({ onSend });
    comp.setReplyTo(42, "bob");
    await record();
    q<HTMLButtonElement>('[data-testid="voice-send"]')!.click();
    await flush();
    expect(onSend.mock.calls[0]?.[1]).toBe(42);
  });

  it("discards a clip under one second without uploading", async () => {
    const onUploadFile = vi.fn();
    const onSend = vi.fn();
    mountComposer({ onUploadFile, onSend });
    await record(500);
    q<HTMLButtonElement>('[data-testid="voice-send"]')!.click();
    await flush();
    expect(onUploadFile).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(q('[data-testid="voice-bar"]')).toBeNull();
    expect(q(".attachment-upload-error-text")?.textContent).toMatch(/too short/);
    expect(stream.allStopped).toBe(true);
  });

  it("cancels on the trash button and on Escape, releasing the microphone", async () => {
    const onUploadFile = vi.fn();
    mountComposer({ onUploadFile });
    await record();
    q<HTMLButtonElement>('[data-testid="voice-cancel"]')!.click();
    expect(q('[data-testid="voice-bar"]')).toBeNull();
    expect(stream.allStopped).toBe(true);

    stream = new FakeStream();
    await record();
    expect(q('[data-testid="voice-bar"]')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(q('[data-testid="voice-bar"]')).toBeNull();
    expect(stream.allStopped).toBe(true);
    expect(onUploadFile).not.toHaveBeenCalled();
  });

  it("shows an error line and no bar when the microphone is denied", async () => {
    mediaDevices.getUserMedia.mockRejectedValue(
      Object.assign(new Error("no"), { name: "NotAllowedError" }),
    );
    mountComposer();
    q<HTMLButtonElement>('[data-testid="voice-mic-btn"]')!.click();
    await flush();
    expect(q('[data-testid="voice-bar"]')).toBeNull();
    expect(q(".attachment-upload-error-text")?.textContent).toMatch(/denied/);
  });
});

describe("edge case 1: a failed upload keeps the clip", () => {
  it("offers Retry, disables Send while uploading, and sends exactly once", async () => {
    let attempt = 0;
    let finish: (u: Uploaded) => void = () => {};
    const onUploadFile = vi.fn((file: File): Promise<Uploaded> => {
      attempt++;
      if (attempt === 1) return Promise.reject(new Error("network down"));
      return new Promise((resolve) => {
        finish = () => resolve({ id: "up-2", url: "/f/2", filename: file.name });
      });
    });
    const onSend = vi.fn();
    mountComposer({ onUploadFile, onSend });
    await record();

    const primary = (): HTMLButtonElement => q<HTMLButtonElement>('[data-testid="voice-send"]')!;
    primary().click();
    await flush();

    // Failed: the clip is still there, with a visible error and Retry.
    expect(q('[data-testid="voice-bar"]')).not.toBeNull();
    expect(q<HTMLElement>('[data-testid="voice-error"]')?.hidden).toBe(false);
    expect(q('[data-testid="voice-error"]')?.textContent).toMatch(/retry/i);
    expect(primary().textContent).toBe("Retry");
    expect(primary().disabled).toBe(false);
    expect(onSend).not.toHaveBeenCalled();

    // Retry uploads again; the button is disabled while that runs.
    primary().click();
    await flush();
    expect(onUploadFile).toHaveBeenCalledTimes(2);
    expect(primary().disabled).toBe(true);
    primary().click();
    await flush();
    expect(onUploadFile).toHaveBeenCalledTimes(2);

    finish({ id: "up-2", url: "/f/2", filename: "voice-message.webm" });
    await flush();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[2]).toEqual(["up-2"]);
    expect(q('[data-testid="voice-bar"]')).toBeNull();
  });

  it("Cancel on a failed clip drops it and sends nothing", async () => {
    const onUploadFile = vi.fn(() => Promise.reject(new Error("503")));
    const onSend = vi.fn();
    mountComposer({ onUploadFile, onSend });
    await record();
    q<HTMLButtonElement>('[data-testid="voice-send"]')!.click();
    await flush();
    q<HTMLButtonElement>('[data-testid="voice-cancel"]')!.click();
    expect(q('[data-testid="voice-bar"]')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("a retained upload", () => {
  /** Record, send, and gate the composer while the upload runs so the finished upload is kept. */
  async function retain(overrides: Partial<MessageInputOptions> = {}) {
    let n = 0;
    let finish: () => void = () => {};
    const onUploadFile = vi.fn(
      (file: File, _signal?: AbortSignal, _progress?: unknown, _voice?: VoiceUploadMeta) =>
        new Promise<Uploaded>((resolve) => {
          const id = `up-${++n}`;
          finish = () => resolve({ id, url: `/f/${id}`, filename: file.name });
        }),
    );
    const onDiscardUpload = vi.fn(async () => {});
    const onSend = vi.fn();
    const comp = mountComposer({ onUploadFile, onDiscardUpload, onSend, ...overrides });
    await record();
    q<HTMLButtonElement>('[data-testid="voice-send"]')!.click();
    await flush();
    comp.setDisabled("Offline");
    finish();
    await flush();
    expect(onSend).not.toHaveBeenCalled();
    return { comp, onUploadFile, onDiscardUpload, onSend, finish: () => finish() };
  }

  it("is withdrawn when the clip is discarded", async () => {
    const { onDiscardUpload } = await retain();
    q<HTMLButtonElement>('[data-testid="voice-cancel"]')!.click();
    expect(onDiscardUpload).toHaveBeenCalledExactlyOnceWith("up-1");
  });

  it("is withdrawn when Escape discards it", async () => {
    const { onDiscardUpload } = await retain();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(onDiscardUpload).toHaveBeenCalledExactlyOnceWith("up-1");
  });

  it("is withdrawn when the composer is destroyed", async () => {
    const { comp, onDiscardUpload } = await retain();
    comp.destroy?.();
    expect(onDiscardUpload).toHaveBeenCalledExactlyOnceWith("up-1");
  });

  it("is reused by Retry while fresh and is not withdrawn by the send", async () => {
    const { comp, onUploadFile, onDiscardUpload, onSend } = await retain();
    comp.setDisabled(null);
    q<HTMLButtonElement>('[data-testid="voice-send"]')!.click();
    await flush();
    expect(onUploadFile).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[2]).toEqual(["up-1"]);
    expect(onDiscardUpload).not.toHaveBeenCalled();
  });

  it("is withdrawn and uploaded again by Retry once it is older than the sweep margin", async () => {
    const { comp, onUploadFile, onDiscardUpload, onSend, finish } = await retain();
    await vi.advanceTimersByTimeAsync(ATTACHMENT_TTL_MS + 1_000);
    comp.setDisabled(null);
    q<HTMLButtonElement>('[data-testid="voice-send"]')!.click();
    await flush();
    expect(onDiscardUpload).toHaveBeenCalledExactlyOnceWith("up-1");
    expect(onUploadFile).toHaveBeenCalledTimes(2);
    expect(onUploadFile.mock.calls[1]?.[3]).toMatchObject({ durationMs: 2_000 });
    finish();
    await flush();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[2]).toEqual(["up-2"]);
    expect(onDiscardUpload).toHaveBeenCalledTimes(1);
  });
});

describe("server upload limit", () => {
  it("refuses a clip larger than the server's cap without uploading", async () => {
    authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 4 } }));
    const onUploadFile = vi.fn();
    const onSend = vi.fn();
    mountComposer({ onUploadFile, onSend });
    await record();
    q<HTMLButtonElement>('[data-testid="voice-send"]')!.click();
    await flush();
    expect(onUploadFile).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(q('[data-testid="voice-error"]')?.textContent).toMatch(/too long for this server/);
    expect(q<HTMLButtonElement>('[data-testid="voice-send"]')!.disabled).toBe(true);
    expect(q('[data-testid="voice-bar"]')).not.toBeNull();
  });
});

describe("edge case 2: the composer is destroyed mid-recording", () => {
  it("stops the tracks and never uploads or sends", async () => {
    const onUploadFile = vi.fn();
    const onSend = vi.fn();
    const comp = mountComposer({ onUploadFile, onSend });
    await record();
    expect(stream.allStopped).toBe(false);

    comp.destroy?.();
    expect(stream.allStopped).toBe(true);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
    clock += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onUploadFile).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("drops an upload that finishes after the composer is gone", async () => {
    let finish: (u: Uploaded) => void = () => {};
    const onUploadFile = vi.fn(
      () =>
        new Promise<Uploaded>((resolve) => {
          finish = resolve;
        }),
    );
    const onDiscardUpload = vi.fn(async () => {});
    const onSend = vi.fn();
    const comp = mountComposer({ onUploadFile, onSend, onDiscardUpload });
    await record();
    q<HTMLButtonElement>('[data-testid="voice-send"]')!.click();
    await flush();
    comp.destroy?.();
    finish({ id: "late", url: "/f/x", filename: "voice-message.webm" });
    await flush();
    expect(onSend).not.toHaveBeenCalled();
    expect(onDiscardUpload).toHaveBeenCalledWith("late");
  });

  it("releases a microphone granted after the composer was destroyed", async () => {
    let grant: (s: FakeStream) => void = () => {};
    mediaDevices.getUserMedia.mockImplementation(
      () => new Promise<FakeStream>((resolve) => (grant = resolve)),
    );
    const comp = mountComposer();
    q<HTMLButtonElement>('[data-testid="voice-mic-btn"]')!.click();
    await flush(); // the lazy recorder has loaded and is waiting on the permission prompt
    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    comp.destroy?.();
    grant(stream);
    await flush();
    expect(stream.allStopped).toBe(true);
  });

  it("never opens the microphone when destroyed while the recorder code loads", async () => {
    const comp = mountComposer();
    q<HTMLButtonElement>('[data-testid="voice-mic-btn"]')!.click();
    comp.destroy?.();
    await flush();
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
});
