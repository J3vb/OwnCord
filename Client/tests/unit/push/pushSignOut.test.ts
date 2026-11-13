import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  supported: true,
  unregister: vi.fn(async () => undefined),
}));
vi.mock("../../../src/platform/desktop", () => ({ desktop: { pushRegistration: host } }));
vi.mock("@lib/hostPlatform", () => ({ isAndroidHost: () => host.supported }));

import { SessionScope } from "../../../src/lib/net/sessionScope";
import { pushSignOut } from "../../../src/features/push/signOut";
import {
  deviceLabel,
  saveSubscriptionId,
  subscriptionId,
} from "../../../src/features/push/pushInstance";

function makeApi() {
  const scope = new SessionScope({ host: "chat.example:8443", generation: 1 });
  return {
    getSession: vi.fn(() => scope),
    revokePushSubscription: vi.fn(async () => undefined),
  };
}

describe("push sign-out", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    host.supported = true;
  });

  it("deletes the server's row with the session's token and drops the push app's registration", async () => {
    saveSubscriptionId("chat.example:8443#7", 42);
    const api = makeApi();

    const done = pushSignOut(api, 7, "tok");

    expect(host.unregister).toHaveBeenCalledWith("chat.example:8443#7");
    expect(api.revokePushSubscription).toHaveBeenCalledWith(42, "tok");
    expect(subscriptionId("chat.example:8443#7")).toBeNull();
    await expect(done).resolves.toBeUndefined();
  });

  it("never rejects: a failed DELETE still lets the sign-out go on", async () => {
    saveSubscriptionId("chat.example:8443#7", 42);
    const api = makeApi();
    api.revokePushSubscription.mockRejectedValue(new Error("offline"));

    await expect(pushSignOut(api, 7, "tok")).resolves.toBeUndefined();
  });

  it("has nothing to wait for without a stored subscription, or outside the Android app", () => {
    const api = makeApi();
    expect(pushSignOut(api, 7, "tok")).toBeNull();
    expect(host.unregister).toHaveBeenCalledTimes(1);

    host.supported = false;
    saveSubscriptionId("chat.example:8443#7", 42);
    expect(pushSignOut(api, 7, "tok")).toBeNull();
    expect(api.revokePushSubscription).not.toHaveBeenCalled();
  });

  it("labels the device with the phone's model when the WebView reports one", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (Linux; Android 16; CPH2655 Build/AP3A.240617.008; wv) AppleWebKit/537.36",
      ),
    ).toBe("android:CPH2655");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36")).toBe(
      "android:phone",
    );
    expect(deviceLabel("Mozilla/5.0 (X11; Linux x86_64)")).toBe("android:phone");
  });
});
