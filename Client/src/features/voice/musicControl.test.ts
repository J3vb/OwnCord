// The Share music button's state and the support probe behind it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ support: vi.fn() }));
vi.mock("../../platform/desktop", () => ({ desktop: { musicAudio: { support: mocks.support } } }));
vi.mock("./MusicPicker", () => ({ showMusicPicker: vi.fn() }));
vi.mock("@lib/voice/livekitSession", () => ({ startMusic: vi.fn(), stopMusic: vi.fn() }));

import {
  cachedMusicSupport,
  getMusicSupport,
  musicButtonState,
  resetMusicSupport,
} from "./musicControl";
import type { VoiceState } from "@stores/voice.store";

const voice = (over: Partial<VoiceState> = {}): VoiceState => ({ ...over }) as VoiceState;
const OK = { ok: true } as const;

beforeEach(() => {
  mocks.support.mockReset();
  resetMusicSupport();
});

describe("musicButtonState", () => {
  it("offers Share music when supported and nothing blocks it", () => {
    const s = musicButtonState(voice(), OK, null);
    expect(s).toMatchObject({ sharing: false, disabled: false });
  });

  it("stays pressable while sharing, whatever else is wrong", () => {
    const s = musicButtonState(voice({ localMusic: true, shareDenied: true }), null, "locked");
    expect(s).toMatchObject({ sharing: true, disabled: false });
  });

  it("is disabled while the probe runs, with the reason when unsupported", () => {
    expect(musicButtonState(voice(), null, null).disabled).toBe(true);
    const off = musicButtonState(voice(), { ok: false, reason: "windowsOld" }, null);
    expect(off.disabled).toBe(true);
    expect(off.title).not.toBe("");
  });

  it("is disabled with the lock reason while the call is not ready", () => {
    expect(musicButtonState(voice(), OK, "Joining")).toMatchObject({
      disabled: true,
      title: "Joining",
    });
  });

  it("is disabled when the server denied sharing", () => {
    expect(musicButtonState(voice({ shareDenied: true }), OK, null).disabled).toBe(true);
  });
});

describe("getMusicSupport", () => {
  it("probes once and keeps a lasting answer", async () => {
    mocks.support.mockResolvedValue({ ok: false, reason: "platform" });
    expect(cachedMusicSupport()).toBeNull();
    const [a, b] = await Promise.all([getMusicSupport(), getMusicSupport()]);
    expect(a).toEqual(b);
    await getMusicSupport();
    expect(mocks.support).toHaveBeenCalledTimes(1);
    expect(cachedMusicSupport()).toEqual({ ok: false, reason: "platform" });
  });

  it("asks again after a missing sound server, which may start later", async () => {
    mocks.support.mockResolvedValue({ ok: false, reason: "noSoundServer" });
    await getMusicSupport();
    expect(cachedMusicSupport()).toBeNull();
    mocks.support.mockResolvedValue(OK);
    expect(await getMusicSupport()).toEqual(OK);
    expect(mocks.support).toHaveBeenCalledTimes(2);
  });

  it("treats a failing probe as unsupported rather than throwing", async () => {
    mocks.support.mockRejectedValue(new Error("boom"));
    expect(await getMusicSupport()).toEqual({ ok: false, reason: "platform" });
  });
});
