import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PushHostEvent,
  PushRegisterRequest,
  PushRegisterResult,
} from "../../../src/platform/contracts/pushRegistration";

const host = vi.hoisted(() => ({
  supported: true,
  register: vi.fn<(r: PushRegisterRequest) => Promise<PushRegisterResult>>(),
  status: vi.fn(async () => ({
    distributors: [
      { id: "io.heckel.ntfy", name: "ntfy" },
      { id: "org.example.up", name: "Other" },
    ],
    current: null,
  })),
  choose: vi.fn(async () => true),
  unregister: vi.fn(async () => undefined),
  follow: vi.fn<(signal: AbortSignal, onEvent: (e: PushHostEvent) => void) => void>(),
}));

vi.mock("../../../src/platform/desktop", () => ({ desktop: { pushRegistration: host } }));

import { ApiClientError } from "../../../src/lib/api";
import { SessionScope } from "../../../src/lib/net/sessionScope";
import { runSessionResets } from "../../../src/lib/net/sessionRegistry";
import { authStore } from "../../../src/stores/auth.store";
import {
  chooseDistributor,
  onReady,
  type PushApi,
} from "../../../src/features/push/pushSubscription";
import { pushStore } from "../../../src/features/push/store";

const KEYS = { endpoint: "https://ntfy.example/up1", p256dh: "P", auth: "A" };

function makeApi(scope = new SessionScope({ host: "chat.example:8443", generation: 1 })) {
  const api = {
    getSession: vi.fn(() => scope),
    getPushVapid: vi.fn(async () => ({ public_key: "VAPID", key_id: "k1" })),
    subscribePush: vi.fn(async () => ({ id: 42 })),
  };
  return { api: api as unknown as PushApi & typeof api, scope };
}

/** Let the attempt's awaits run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function lastEventHandler(): (e: PushHostEvent) => void {
  const call = host.follow.mock.calls.at(-1);
  if (call === undefined) throw new Error("not following");
  return call[1];
}

describe("push subscription", () => {
  beforeEach(() => {
    runSessionResets("user");
    vi.clearAllMocks();
    host.register.mockResolvedValue({ ok: true, keys: KEYS });
    authStore.setState((s) => ({ ...s, user: { id: 7 } as never, serverName: "Home" }));
  });

  it("registers after ready and sends the endpoint and keys to the server", async () => {
    const { api } = makeApi();
    onReady(api);
    await settle();

    expect(host.register).toHaveBeenCalledWith(
      expect.objectContaining({
        instance: "chat.example:8443#7",
        vapid: "VAPID",
        serverName: "Home",
      }),
    );
    expect(api.subscribePush).toHaveBeenCalledWith(
      {
        endpoint: KEYS.endpoint,
        keys: { p256dh: "P", auth: "A" },
        device_name: expect.stringMatching(/^android:/),
      },
      expect.any(AbortSignal),
    );
    expect(pushStore.getState().setting).toBe("on");
  });

  it("registers once per session: a reconnect's ready sends nothing, a new sign-in sends again", async () => {
    const first = makeApi();
    onReady(first.api);
    onReady(first.api);
    await settle();
    expect(first.api.subscribePush).toHaveBeenCalledTimes(1);

    runSessionResets("user");
    const second = makeApi(new SessionScope({ host: "chat.example:8443", generation: 2 }));
    onReady(second.api);
    await settle();
    expect(second.api.subscribePush).toHaveBeenCalledTimes(1);
  });

  it("a server with push off is shown once and not asked again when the app comes back", async () => {
    const { api } = makeApi();
    api.getPushVapid.mockRejectedValue(new ApiClientError(503, "PUSH_DISABLED", "off"));
    onReady(api);
    await settle();
    expect(pushStore.getState().setting).toBe("server-off");

    lastEventHandler()({ kind: "resume" });
    await settle();
    expect(api.getPushVapid).toHaveBeenCalledTimes(1);
    expect(host.register).not.toHaveBeenCalled();
  });

  it("with no push app it asks for one, and registers by itself once the app is back", async () => {
    const { api } = makeApi();
    host.register.mockResolvedValueOnce({ ok: false, reason: "no-distributor" });
    onReady(api);
    await settle();
    expect(pushStore.getState().setting).toBe("install");
    expect(api.subscribePush).not.toHaveBeenCalled();

    lastEventHandler()({ kind: "resume" });
    await settle();
    expect(api.subscribePush).toHaveBeenCalledTimes(1);
    expect(pushStore.getState().setting).toBe("on");
  });

  it("with several push apps it lists them, and a pick registers", async () => {
    const { api } = makeApi();
    host.register.mockResolvedValueOnce({ ok: false, reason: "choose" });
    onReady(api);
    await settle();
    expect(pushStore.getState()).toEqual({
      setting: "choose",
      distributors: [
        { id: "io.heckel.ntfy", name: "ntfy" },
        { id: "org.example.up", name: "Other" },
      ],
    });

    await chooseDistributor("io.heckel.ntfy");
    expect(host.choose).toHaveBeenCalledWith("io.heckel.ntfy");
    expect(api.subscribePush).toHaveBeenCalledTimes(1);
  });

  it("an attempt superseded by a sign-out mid-way posts nothing and writes nothing", async () => {
    const { api, scope } = makeApi();
    let answer!: (r: PushRegisterResult) => void;
    host.register.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    onReady(api);
    await settle();

    runSessionResets("user");
    scope.dispose();
    answer({ ok: true, keys: KEYS });
    await settle();

    expect(api.subscribePush).not.toHaveBeenCalled();
    expect(pushStore.getState().setting).toBe("off");
  });

  it("an endpoint the push app moved is sent again; another account's is not", async () => {
    const { api } = makeApi();
    onReady(api);
    await settle();

    lastEventHandler()({ kind: "endpoint", instance: "other.example#1" });
    await settle();
    expect(api.subscribePush).toHaveBeenCalledTimes(1);

    lastEventHandler()({ kind: "endpoint", instance: "chat.example:8443#7" });
    await settle();
    expect(api.subscribePush).toHaveBeenCalledTimes(2);
  });

  it("every sign-out drops the push app's registration; a quick switch keeps it", async () => {
    const first = makeApi();
    onReady(first.api);
    await settle();
    runSessionResets("server_switch");
    expect(host.unregister).not.toHaveBeenCalled();

    const second = makeApi(new SessionScope({ host: "chat.example:8443", generation: 2 }));
    onReady(second.api);
    await settle();
    runSessionResets("user");
    expect(host.unregister).toHaveBeenCalledExactlyOnceWith("chat.example:8443#7");

    runSessionResets("user");
    expect(host.unregister).toHaveBeenCalledTimes(1);
  });

  it("a pick that lands after a sign-out writes nothing", async () => {
    const { api } = makeApi();
    host.register.mockResolvedValueOnce({ ok: false, reason: "choose" });
    onReady(api);
    await settle();
    let picked!: (ok: boolean) => void;
    host.choose.mockReturnValueOnce(new Promise((resolve) => (picked = resolve)));

    const choosing = chooseDistributor("io.heckel.ntfy");
    runSessionResets("user");
    picked(false);
    await choosing;

    expect(pushStore.getState().setting).toBe("off");
    expect(api.subscribePush).not.toHaveBeenCalled();
  });

  it("follows the host for as long as the session lasts", async () => {
    const { api, scope } = makeApi();
    onReady(api);
    await settle();
    expect(host.follow).toHaveBeenCalledWith(scope.signal, expect.any(Function));
  });
});
