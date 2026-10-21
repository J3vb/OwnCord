// WP 6.7b: the Windows quality step's "Share the app's sound" switch
// (src/components/ScreenSharePicker.ts, osPicker branch).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) as unknown }));

const { showScreenSharePicker } = await import("../../src/components/ScreenSharePicker");

const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36";

function userAgent(ua: string): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}

const options = {
  sources: [],
  portal: false,
  osPicker: true,
  defaultQuality: "medium",
  defaultFps: 30,
} as const;

const toggle = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="ssp-share-audio"]');

async function open(opts: Parameters<typeof showScreenSharePicker>[0] = options) {
  const result = showScreenSharePicker(opts);
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="screen-share-go-live"]')).not.toBeNull(),
  );
  return { result };
}

const goLive = (): void =>
  document.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();

beforeEach(() => {
  invoke.mockReset();
});

afterEach(() => {
  // Closing the dialog releases its document key listener.
  document.querySelector<HTMLButtonElement>(".btn-modal-cancel")?.click();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("the Windows quality step's app-sound switch", () => {
  it("shows the switch, on by default, when the host can capture an app's sound", async () => {
    userAgent(WINDOWS_UA);
    invoke.mockResolvedValue(true);

    const { result } = await open();

    expect(invoke).toHaveBeenCalledWith("app_audio_available");
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain("Share the app's sound");
    expect(document.body.textContent).toContain(
      "When you share one window, its app's sound is shared too.",
    );
    goLive();
    expect(await result).toMatchObject({ source: "os", audio: true });
  });

  it("returns audio:false once switched off", async () => {
    userAgent(WINDOWS_UA);
    invoke.mockResolvedValue(true);
    const { result } = await open();

    toggle()!.click();
    expect(toggle()!.getAttribute("aria-checked")).toBe("false");
    goLive();

    expect(await result).toMatchObject({ audio: false });
  });

  it("shows no switch and returns no audio when the host cannot", async () => {
    userAgent(WINDOWS_UA);
    invoke.mockResolvedValue(false);
    const { result } = await open();

    expect(toggle()).toBeNull();
    goLive();
    expect(await result).not.toHaveProperty("audio");
  });

  it("shows no switch when the host call fails", async () => {
    userAgent(WINDOWS_UA);
    invoke.mockRejectedValue(new Error("no host"));
    await open();

    expect(toggle()).toBeNull();
  });

  it("does not ask the host off Windows", async () => {
    userAgent(LINUX_UA);
    await open();

    expect(invoke).not.toHaveBeenCalled();
    expect(toggle()).toBeNull();
  });

  it("does not ask the host for Change source (sourceOnly)", async () => {
    userAgent(WINDOWS_UA);
    invoke.mockResolvedValue(true);
    await open({ ...options, sourceOnly: true });

    expect(invoke).not.toHaveBeenCalled();
    expect(toggle()).toBeNull();
  });

  it("says a whole screen still shares all sound", async () => {
    userAgent(WINDOWS_UA);
    invoke.mockResolvedValue(true);
    await open();

    expect(document.body.textContent).toContain("A whole screen shares all sound");
  });
});
