// owncord:// links in the Android app: the deep-link plugin runs there too,
// the manifest's intent filter takes the place of runtime registration, and a
// link reaches the same handlers as on desktop, cold (the link started the
// app) and warm (the app was running: singleTask hands it to onNewIntent).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import tauriConf from "../../../src-tauri/tauri.conf.json";

const register = vi.fn();
const getCurrent = vi.fn();
const onOpenUrl = vi.fn();

vi.mock("@tauri-apps/plugin-deep-link", () => ({
  register: (...args: unknown[]) => register(...args) as unknown,
  getCurrent: (...args: unknown[]) => getCurrent(...args) as unknown,
  onOpenUrl: (...args: unknown[]) => onOpenUrl(...args) as unknown,
}));
vi.mock("@lib/hostPlatform", () => ({ isAndroidHost: () => true }));

const {
  deepLinks: { init },
} = await import("../../../src/platform/desktop/deepLinks");

beforeEach(() => {
  register.mockReset().mockRejectedValue(new Error("unsupported on this platform"));
  getCurrent.mockReset().mockResolvedValue(null);
  onOpenUrl.mockReset().mockResolvedValue(undefined);
});

function warmHandler(): (urls: readonly string[]) => void {
  const handler = onOpenUrl.mock.calls[0]?.[0] as ((urls: readonly string[]) => void) | undefined;
  expect(handler).toBeTypeOf("function");
  return handler as (urls: readonly string[]) => void;
}

describe("owncord:// links in the Android app", () => {
  it("asks for no runtime registration, which Android does not have", async () => {
    await init(vi.fn(), vi.fn());

    expect(register).not.toHaveBeenCalled();
    expect(getCurrent).toHaveBeenCalledTimes(1);
    expect(onOpenUrl).toHaveBeenCalledTimes(1);
  });

  it("opens the join screen for an invite link that started the app", async () => {
    getCurrent.mockResolvedValue(["owncord://invite/PHONE1?host=chat.example:8443"]);
    const onInvite = vi.fn();
    const onMessage = vi.fn();

    await init(onInvite, onMessage);

    expect(onInvite).toHaveBeenCalledWith("PHONE1", "chat.example:8443");
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("opens the message for a message link that started the app", async () => {
    getCurrent.mockResolvedValue(["owncord://message/12/345"]);
    const onInvite = vi.fn();
    const onMessage = vi.fn();

    await init(onInvite, onMessage);

    expect(onMessage).toHaveBeenCalledWith(12, 345, undefined);
    expect(onInvite).not.toHaveBeenCalled();
  });

  it("takes a link tapped while the app runs through the warm path only", async () => {
    const onInvite = vi.fn();
    const onMessage = vi.fn();
    await init(onInvite, onMessage);

    warmHandler()(["owncord://message/3/9"]);
    warmHandler()(["owncord://invite/WARM2"]);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(3, 9, undefined);
    expect(onInvite).toHaveBeenCalledTimes(1);
    expect(onInvite).toHaveBeenCalledWith("WARM2", undefined);
    expect(getCurrent).toHaveBeenCalledTimes(1);
  });
});

describe("the owncord scheme on Android", () => {
  it("is a custom scheme in the plugin's mobile config, not a verified web link", () => {
    expect(tauriConf.plugins["deep-link"].mobile).toEqual([
      { scheme: ["owncord"], appLink: false },
    ]);
  });

  it("is in the activity's intent filter, so Chrome and other apps can open it", () => {
    const manifest = readFileSync(
      join(__dirname, "../../../src-tauri/gen/android/app/src/main/AndroidManifest.xml"),
      "utf8",
    );
    const activity = /<activity\b[\s\S]*?<\/activity>/.exec(manifest)?.[0] ?? "";
    const filter =
      /<intent-filter\s*>\s*<action android:name="android\.intent\.action\.VIEW" \/>([\s\S]*?)<\/intent-filter>/.exec(
        activity,
      )?.[1];
    expect(filter).toBeDefined();
    expect(filter).toContain('<category android:name="android.intent.category.BROWSABLE" />');
    expect(filter).toContain('<data android:scheme="owncord" />');
    expect(filter).not.toContain("android:host");
  });
});
