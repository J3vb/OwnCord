// The music host calls: which command each OS gets, and that a refusal from
// the host becomes a typed answer rather than a throw.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ android: false, tryInvoke: vi.fn() }));
vi.mock("@lib/hostPlatform", () => ({ isAndroidHost: () => host.android }));
vi.mock("../../../../src/platform/desktop/nativeInvoke", () => ({ tryInvoke: host.tryInvoke }));

import { musicAudio } from "../../../../src/platform/desktop/musicAudio";

const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64)";

function agent(ua: string): void {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ua);
}
const ok = (value: unknown) => Promise.resolve({ ok: true, value });
const refused = (reason: unknown) => Promise.resolve({ ok: false, error: { reason } });

beforeEach(() => {
  host.android = false;
  host.tryInvoke.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("musicAudio support", () => {
  it("is not available on Android or an unknown OS", async () => {
    host.android = true;
    agent(LINUX);
    expect(await musicAudio.support()).toEqual({ ok: false, reason: "android" });
    host.android = false;
    agent("Mozilla/5.0 (Macintosh)");
    expect(await musicAudio.support()).toEqual({ ok: false, reason: "platform" });
    expect(host.tryInvoke).not.toHaveBeenCalled();
  });

  it("asks a Windows host whether per-app capture exists", async () => {
    agent(WINDOWS);
    host.tryInvoke.mockReturnValueOnce(ok(true));
    expect(await musicAudio.support()).toEqual({ ok: true });
    host.tryInvoke.mockReturnValueOnce(ok(false));
    expect(await musicAudio.support()).toEqual({ ok: false, reason: "windowsOld" });
    expect(host.tryInvoke).toHaveBeenCalledWith("app_audio_available");
  });

  it("probes a Linux host with the app list and names a missing sound server", async () => {
    agent(LINUX);
    host.tryInvoke.mockReturnValueOnce(ok([]));
    expect(await musicAudio.support()).toEqual({ ok: true });
    host.tryInvoke.mockReturnValueOnce(refused("unavailable"));
    expect(await musicAudio.support()).toEqual({ ok: false, reason: "noSoundServer" });
  });
});

describe("musicAudio listApps", () => {
  it("reads the apps with the command of the host OS", async () => {
    agent(WINDOWS);
    host.tryInvoke.mockReturnValueOnce(
      ok([
        { id: "1", name: "Player", icon: "", playing: true },
        { id: "2", name: "Other" },
      ]),
    );
    expect(await musicAudio.listApps()).toEqual({
      ok: true,
      apps: [
        { id: "1", name: "Player", icon: null, playing: true },
        { id: "2", name: "Other", icon: null, playing: false },
      ],
    });
    expect(host.tryInvoke).toHaveBeenLastCalledWith("list_audio_apps");
    agent(LINUX);
    host.tryInvoke.mockReturnValueOnce(ok([]));
    await musicAudio.listApps();
    expect(host.tryInvoke).toHaveBeenLastCalledWith("native_voice_list_audio_apps");
  });

  it("turns a malformed list or a refusal into a code", async () => {
    agent(WINDOWS);
    host.tryInvoke.mockReturnValueOnce(ok([{ id: 1 }]));
    expect(await musicAudio.listApps()).toEqual({ ok: false, code: "internal" });
    host.tryInvoke.mockReturnValueOnce(refused("activation_failed"));
    expect(await musicAudio.listApps()).toEqual({ ok: false, code: "activation_failed" });
    host.tryInvoke.mockReturnValueOnce(refused("something else"));
    expect(await musicAudio.listApps()).toEqual({ ok: false, code: "unavailable" });
  });
});

describe("musicAudio start and stop", () => {
  it("starts a Windows capture and returns the socket address", async () => {
    agent(WINDOWS);
    host.tryInvoke.mockReturnValueOnce(ok("ws://127.0.0.1:1/x"));
    expect(await musicAudio.start("7")).toEqual({ ok: true, url: "ws://127.0.0.1:1/x" });
    expect(host.tryInvoke).toHaveBeenCalledWith("start_music_audio", { appId: "7" });
    host.tryInvoke.mockReturnValueOnce(ok(""));
    expect(await musicAudio.start("7")).toEqual({ ok: false, code: "internal" });
    host.tryInvoke.mockReturnValueOnce(refused("not_found"));
    expect(await musicAudio.start("7")).toEqual({ ok: false, code: "not_found" });
  });

  it("leaves capture to the native room off Windows", async () => {
    agent(LINUX);
    expect(await musicAudio.start("7")).toEqual({ ok: false, code: "unavailable" });
    await musicAudio.stop();
    expect(host.tryInvoke).not.toHaveBeenCalled();
  });

  it("stops without throwing when the host refuses", async () => {
    agent(WINDOWS);
    host.tryInvoke.mockReturnValueOnce(refused("internal"));
    await expect(musicAudio.stop()).resolves.toBeUndefined();
    expect(host.tryInvoke).toHaveBeenCalledWith("stop_music_audio");
  });
});
