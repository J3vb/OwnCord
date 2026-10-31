import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import * as wsMocks from "./helpers/ws-mocks";

vi.mock("@tauri-apps/api/core", () => wsMocks.tauriCoreMock());
vi.mock("@tauri-apps/api/event", () => wsMocks.tauriEventMock());

import { mockInvoke } from "./helpers/ws-mocks";
import { createWsClient, setIdentityKeyProvider } from "../../src/lib/ws";
import { useWsClientFixture } from "../helpers/wsClientFixture";
import { openSocket } from "../helpers/wsSuiteHarness";

function authFrames(): Array<Record<string, unknown>> {
  return mockInvoke.mock.calls
    .filter(
      (c) =>
        c[0] === "ws_send" &&
        typeof c[1]?.message === "string" &&
        (c[1].message as string).includes('"type":"auth"'),
    )
    .map(
      (c) =>
        (JSON.parse((c[1] as { message: string }).message) as { payload: Record<string, unknown> })
          .payload,
    );
}

/** Exactly one auth frame went out, and it carries no identity key. */
function expectKeylessAuth(): void {
  const frames = authFrames();
  expect(frames).toHaveLength(1);
  expect(Object.prototype.hasOwnProperty.call(frames[0], "identity_public_key")).toBe(false);
}

describe("auth frame: identity_public_key", () => {
  let client: ReturnType<typeof createWsClient>;

  useWsClientFixture((created) => {
    client = created;
  });

  beforeEach(() => setIdentityKeyProvider(null));
  afterEach(() => setIdentityKeyProvider(null));

  async function open(): Promise<void> {
    await openSocket(client);
    await vi.advanceTimersByTimeAsync(10);
  }

  it("carries this device's key, asked for the host being dialled", async () => {
    const provider = vi.fn(async () => "device-key");
    setIdentityKeyProvider(provider);
    await open();
    expect(provider).toHaveBeenCalledWith("localhost:8443");
    const frames = authFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.identity_public_key).toBe("device-key");
    expect(frames[0]?.token).toBe("t");
  });

  it("still sends auth, without the key, when the keyring fails", async () => {
    setIdentityKeyProvider(async () => {
      throw new Error("keyring locked");
    });
    await open();
    expectKeylessAuth();
  });

  it("still sends auth, without the key, when the provider has none", async () => {
    setIdentityKeyProvider(async () => null);
    await open();
    expectKeylessAuth();
  });

  it("does not wait on a hung keyring: auth goes out without the key after the cap", async () => {
    setIdentityKeyProvider(() => new Promise<string | null>(() => {}));
    await open();
    expect(authFrames()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expectKeylessAuth();
  });

  it("drops the frame of an attempt that a disconnect superseded while the key loaded", async () => {
    let release: (key: string) => void = () => {};
    setIdentityKeyProvider(() => new Promise<string | null>((resolve) => (release = resolve)));
    await open();
    client.disconnect();
    release("late-key");
    await vi.advanceTimersByTimeAsync(10);
    expect(authFrames()).toHaveLength(0);
  });

  it("sends a frame without the key when no provider is registered", async () => {
    await open();
    expectKeylessAuth();
  });
});
