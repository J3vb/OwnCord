import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Disposable } from "../../../../src/lib/disposable";
import type { MobileAudio, MobileAudioState } from "../../../../src/platform/contracts/mobileAudio";
import { createDeferred } from "../../../helpers/deferred";

const native = vi.hoisted(() => ({
  android: true,
  invoke: vi.fn(),
  listen: vi.fn(),
  unregister: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("@lib/hostPlatform", () => ({ isAndroidHost: () => native.android }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ warn: native.warn, debug: vi.fn() }),
}));
// The real `tryInvoke` stays in, so a rejected command is the typed error the
// member really gets.
vi.mock("@tauri-apps/api/core", () => ({
  addPluginListener: native.listen,
  invoke: native.invoke,
}));

/** Let the host side load and every answer land. */
async function settle(): Promise<void> {
  await vi.dynamicImportSettled();
  await new Promise((r) => setTimeout(r, 0));
}

/** A state as the plugin sends it: numbered. */
function audio(seq: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq,
    supported: true,
    routes: [
      { kind: "speaker", name: "" },
      { kind: "earpiece", name: "" },
    ],
    active: "speaker",
    manual: null,
    interrupted: false,
    ...over,
  };
}

let owner: Disposable;
/** The plugin's `state` event, as each watcher registered for it. */
let emit: ((payload: unknown) => void)[];
let onState: Mock<(state: MobileAudioState) => void>;

async function load(): Promise<MobileAudio> {
  return (await import("../../../../src/platform/desktop/mobileAudio")).mobileAudio;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  owner = new Disposable();
  emit = [];
  onState = vi.fn<(state: MobileAudioState) => void>();
  native.android = true;
  native.unregister.mockResolvedValue(undefined);
  native.listen.mockImplementation(
    (_plugin: string, _event: string, handler: (payload: unknown) => void) => {
      emit.push(handler);
      return Promise.resolve({ unregister: native.unregister });
    },
  );
  native.invoke.mockResolvedValue(audio(1));
});
afterEach(() => owner.destroy());

describe("native call audio", () => {
  it("neither listens nor invokes off the Android app", async () => {
    native.android = false;
    const mobileAudio = await load();
    mobileAudio.watch(owner.signal, onState);
    mobileAudio.setSession(true);
    mobileAudio.setRoute("earpiece");
    mobileAudio.refresh();
    await settle();
    expect(native.listen).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
  });

  it("listens first, then asks for the state, and hands on each change", async () => {
    const mobileAudio = await load();
    mobileAudio.watch(owner.signal, onState);
    await settle();
    expect(native.listen).toHaveBeenCalledWith(
      "owncord-mobile-audio",
      "state",
      expect.any(Function),
    );
    expect(native.invoke.mock.calls).toEqual([["mobile_audio_state"]]);
    expect(native.listen.mock.invocationCallOrder[0]).toBeLessThan(
      native.invoke.mock.invocationCallOrder[0]!,
    );
    expect(onState.mock.calls).toEqual([
      [
        {
          supported: true,
          routes: [
            { kind: "speaker", name: "" },
            { kind: "earpiece", name: "" },
          ],
          active: "speaker",
          manual: null,
          interrupted: false,
        },
      ],
    ]);

    emit[0]!(audio(2, { active: "earpiece", manual: "earpiece", interrupted: true }));
    expect(onState).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: "earpiece", manual: "earpiece", interrupted: true }),
    );
  });

  it("drops an answer that arrives after a newer event", async () => {
    const answer = createDeferred<unknown>();
    native.invoke.mockReturnValueOnce(answer.promise);
    const mobileAudio = await load();
    mobileAudio.watch(owner.signal, onState);
    await settle();
    emit[0]!(audio(5, { active: "bluetooth" }));
    answer.resolve(audio(4));
    await settle();
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ active: "bluetooth" }));
    // The same number again is the same state: not handed on twice.
    emit[0]!(audio(5, { active: "earpiece" }));
    expect(onState).toHaveBeenCalledTimes(1);
  });

  it("hands nothing on before its listener is in", async () => {
    const listener = createDeferred<{ unregister: typeof native.unregister }>();
    native.listen.mockImplementationOnce(
      (_plugin: string, _event: string, handler: (payload: unknown) => void) => {
        emit.push(handler);
        return listener.promise;
      },
    );
    native.invoke.mockResolvedValue(audio(3, { active: "earpiece" }));
    const mobileAudio = await load();
    mobileAudio.watch(owner.signal, onState);
    await settle();
    emit[0]!(audio(2));
    expect(onState).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();

    listener.resolve({ unregister: native.unregister });
    await settle();
    expect(onState.mock.calls).toEqual([[expect.objectContaining({ active: "earpiece" })]]);
  });

  it("reports nothing at all without its events", async () => {
    native.listen.mockRejectedValueOnce(new Error("plugin missing"));
    const mobileAudio = await load();
    mobileAudio.watch(owner.signal, onState);
    await settle();
    expect(native.warn).toHaveBeenCalledTimes(1);
    expect(native.invoke).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
  });

  it("stops listening when its watcher goes, and ignores what arrives after", async () => {
    const answer = createDeferred<unknown>();
    const mobileAudio = await load();
    mobileAudio.watch(owner.signal, onState);
    await settle();
    native.invoke.mockReturnValueOnce(answer.promise);
    mobileAudio.refresh();
    await settle();
    owner.destroy();
    expect(native.unregister).toHaveBeenCalledTimes(1);
    emit[0]!(audio(8, { active: "earpiece" }));
    answer.resolve(audio(9, { active: "bluetooth" }));
    await settle();
    expect(onState).toHaveBeenCalledTimes(1);
  });

  it("unregisters a listener that arrives after its watcher went", async () => {
    const listener = createDeferred<{ unregister: typeof native.unregister }>();
    native.listen.mockReturnValueOnce(listener.promise);
    const mobileAudio = await load();
    mobileAudio.watch(owner.signal, onState);
    await settle();
    owner.destroy();
    listener.resolve({ unregister: native.unregister });
    await settle();
    expect(native.unregister).toHaveBeenCalledTimes(1);
    expect(native.invoke).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
  });

  it("never starts for a watcher that is already gone", async () => {
    const mobileAudio = await load();
    owner.destroy();
    mobileAudio.watch(owner.signal, onState);
    await settle();
    expect(native.listen).not.toHaveBeenCalled();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("lets a second watcher take over: the first one's late states go nowhere", async () => {
    const late = createDeferred<unknown>();
    native.invoke.mockReturnValueOnce(late.promise);
    const first = vi.fn();
    const mobileAudio = await load();
    mobileAudio.watch(owner.signal, first);
    await settle();
    mobileAudio.watch(owner.signal, onState);
    await settle();
    expect(onState).toHaveBeenCalledTimes(1);

    late.resolve(audio(7, { active: "bluetooth" }));
    emit[0]!(audio(8, { active: "wired" }));
    await settle();
    expect(first).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledTimes(1);

    // The second watcher's own events still arrive, numbered from the start.
    emit[1]!(audio(2, { active: "earpiece" }));
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ active: "earpiece" }));
  });

  it("sends each command in the order it was made, also before the host side loaded", async () => {
    const mobileAudio = await load();
    mobileAudio.setSession(true);
    mobileAudio.setRoute("earpiece");
    mobileAudio.setRoute(null);
    mobileAudio.setSession(false);
    mobileAudio.refresh();
    await settle();
    expect(native.invoke.mock.calls).toEqual([
      ["mobile_audio_set_session", { active: true }],
      ["mobile_audio_set_route", { kind: "earpiece" }],
      ["mobile_audio_set_route", { kind: "" }],
      ["mobile_audio_set_session", { active: false }],
      ["mobile_audio_state"],
    ]);
    // With nobody watching, their answers are for nobody.
    expect(onState).not.toHaveBeenCalled();
  });

  it("takes a command's answer as the state the command left", async () => {
    const mobileAudio = await load();
    mobileAudio.watch(owner.signal, onState);
    await settle();
    native.invoke.mockResolvedValueOnce(audio(2, { active: "earpiece", manual: "earpiece" }));
    mobileAudio.setRoute("earpiece");
    await settle();
    expect(onState).toHaveBeenCalledTimes(2);
    expect(onState).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: "earpiece", manual: "earpiece" }),
    );
  });

  it("warns about a refused command and keeps the last state", async () => {
    const mobileAudio = await load();
    mobileAudio.watch(owner.signal, onState);
    await settle();
    native.invoke.mockRejectedValueOnce("no such device");
    mobileAudio.setRoute("wired");
    await settle();
    expect(native.warn).toHaveBeenCalledWith("mobile_audio_set_route failed", "no such device");
    expect(onState).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["nothing", null],
    ["text", "speaker"],
    ["an empty object", {}],
    ["a state with no number", { ...audio(2), seq: undefined }],
    ["a state that does not say whether it is supported", { ...audio(2), supported: "yes" }],
    ["a route in use it does not know", audio(2, { active: "hdmi" })],
    ["routes that are no list", audio(2, { routes: "speaker" })],
  ])("drops %s", async (_what, payload) => {
    const mobileAudio = await load();
    mobileAudio.watch(owner.signal, onState);
    await settle();
    emit[0]!(payload);
    expect(onState).toHaveBeenCalledTimes(1);
    // A dropped state does not use up a number.
    emit[0]!(audio(2, { active: "earpiece" }));
    expect(onState).toHaveBeenCalledTimes(2);
  });

  it("keeps the routes it knows and reads the rest strictly", async () => {
    const mobileAudio = await load();
    mobileAudio.watch(owner.signal, onState);
    await settle();
    emit[0]!(
      audio(2, {
        routes: [
          { kind: "bluetooth", name: "WH-1000XM5" },
          { kind: "hdmi", name: "TV" },
          { kind: "wired", name: 7 },
          "speaker",
          null,
        ],
        active: "bluetooth",
        manual: "telepathy",
        interrupted: 1,
      }),
    );
    expect(onState).toHaveBeenLastCalledWith({
      supported: true,
      routes: [
        { kind: "bluetooth", name: "WH-1000XM5" },
        { kind: "wired", name: "" },
      ],
      active: "bluetooth",
      manual: null,
      interrupted: false,
    });
  });
});
