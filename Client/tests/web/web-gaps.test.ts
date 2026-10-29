/**
 * Gaps the web build used to have against the desktop app: the app version,
 * an invite for another server, and the log folder button. Runs in the `web`
 * project, where `__OWNCORD_WEB__` is true and the browser platform is wired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lib/livekitSession", () => ({
  leaveVoice: vi.fn(),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
  getShareDiagnostics: vi.fn().mockReturnValue(null),
}));

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@lib/toast", () => ({ showToast }));

const { desktop } = await import("../../src/platform/desktop");
const { renderMessageContent } = await import("../../src/components/message-list/content-parser");
const { setChannelMutesHost } = await import("../../src/lib/channel-mutes");
const { setInviteJoinHandler } = await import("../../src/lib/invite-navigation");
const { createLogsTab } = await import("../../src/components/settings/LogsTab");

describe("app version (web build)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports the version the bundle was built from", async () => {
    vi.stubEnv("OWNCORD_APP_VERSION", "2.5.1");
    await expect(desktop.appMetadata.getVersion()).resolves.toBe("2.5.1");
  });

  it("refuses when the build carries no version", async () => {
    vi.stubEnv("OWNCORD_APP_VERSION", "");
    await expect(desktop.appMetadata.getVersion()).rejects.toThrow();
  });
});

describe("invite chip for another server (web build)", () => {
  const joined: Array<[string, string | undefined]> = [];
  let unregister: () => void;

  beforeEach(() => {
    joined.length = 0;
    unregister = setInviteJoinHandler((code, host) => joined.push([code, host]));
    setChannelMutesHost("here.example");
  });

  afterEach(() => {
    unregister();
    setChannelMutesHost(null);
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  function chip(text: string): HTMLElement {
    const root = document.createElement("div");
    root.appendChild(renderMessageContent(text));
    document.body.appendChild(root);
    return root.querySelector<HTMLElement>(".message-link-chip")!;
  }

  it("opens that server's page in a new tab and keeps this session", () => {
    const open = vi.spyOn(window, "open").mockReturnValue({ opener: null } as unknown as Window);
    chip("owncord://invite/abc123?host=there.example:8443").click();
    expect(open).toHaveBeenCalledWith("https://there.example:8443/?invite=abc123", "_blank");
    expect(joined).toEqual([]);
    expect(document.querySelector("[data-testid='invite-join-dialog']")).toBeNull();
  });

  it("says so when the browser blocks the tab", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    chip("owncord://invite/abc123?host=there.example").click();
    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining("Couldn't open that server's page"),
        "error",
      ),
    );
    expect(joined).toEqual([]);
  });
});

describe("Logs tab (web build)", () => {
  it("offers no log folder to open", () => {
    const controller = new AbortController();
    const el = createLogsTab(() => "Logs" as never, controller.signal).build();
    expect(el.querySelector("[data-testid='open-log-folder']")).toBeNull();
    expect(el.querySelector("[data-testid='get-help']")).not.toBeNull();
    controller.abort();
  });
});
