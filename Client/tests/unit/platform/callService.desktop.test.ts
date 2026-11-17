// The desktop registry's call service talks to the host only in the Android
// app, where its host side loads on first use and sends one state at a time;
// a host refusal never reaches the caller. The buttons of the host's call
// notifications come back as the plugin's `action` event, to the newest
// listener only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Disposable } from "../../../src/lib/disposable";
import type {
  CallAction,
  CallMic,
  CallService,
  CallServiceState,
} from "../../../src/platform/contracts/callService";
import { createDeferred } from "../../helpers/deferred";

const host = vi.hoisted(() => ({
  android: true,
  invoke: vi.fn(),
  listen: vi.fn(),
  unregister: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@lib/hostPlatform", () => ({ isAndroidHost: () => host.android }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ warn: host.warn, debug: vi.fn() }),
}));
// The real `tryInvoke` stays in, so a rejected command is the typed error the
// member really gets.
vi.mock("@tauri-apps/api/core", () => ({ addPluginListener: host.listen, invoke: host.invoke }));

/** Let the host side load and every answer land. */
async function settle(): Promise<void> {
  await vi.dynamicImportSettled();
  await new Promise((r) => setTimeout(r, 0));
}

async function load(): Promise<CallService> {
  return (await import("../../../src/platform/desktop/callService")).callService;
}

const JOINED: CallServiceState = { active: true, camera: false, videoOnScreen: false, mic: "live" };
const CAMERA_ON: CallServiceState = { ...JOINED, camera: true };
const CAMERA_SHOWN: CallServiceState = { ...CAMERA_ON, videoOnScreen: true };
const LEFT: CallServiceState = { ...JOINED, active: false };

/** The words the host shows for a microphone state, as it is sent them. */
interface Face {
  readonly mic: CallMic;
  readonly text: string;
  readonly micLabel: string | null;
  readonly leaveLabel: string;
}

/** What the host was sent so far, in the order it got it. */
function sentArgs(): (Omit<CallServiceState, "mic"> & { face: Face })[] {
  return host.invoke.mock.calls.map(([command, args]) => {
    expect(command).toBe("set_call_service");
    return args as Omit<CallServiceState, "mic"> & { face: Face };
  });
}

/** The same, as the states they were sent for. */
function sent(): CallServiceState[] {
  return sentArgs().map(({ face, ...rest }) => ({ ...rest, mic: face.mic }));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  host.android = true;
  host.invoke.mockReset();
  host.invoke.mockResolvedValue(null);
});

describe("desktop call service", () => {
  it("sends each state to the Android host in order", async () => {
    const callService = await load();
    const states = [JOINED, CAMERA_SHOWN, CAMERA_ON, LEFT];
    // The first ones are made while the host side is still loading.
    for (const state of states) callService.update(state);
    await settle();
    expect(sent()).toEqual(states);
  });

  it("sends a state only once the one before it was answered", async () => {
    // A camera goes on as its picture appears: sent together, the two could
    // reach the host either way round and leave the older state standing.
    const first = createDeferred<null>();
    host.invoke.mockReturnValueOnce(first.promise);
    const callService = await load();
    callService.update(CAMERA_ON);
    callService.update(CAMERA_SHOWN);
    await settle();
    expect(sent()).toEqual([CAMERA_ON]);

    first.resolve(null);
    await settle();
    expect(sent()).toEqual([CAMERA_ON, CAMERA_SHOWN]);
  });

  it("does nothing outside the Android app", async () => {
    host.android = false;
    const callService = await load();
    callService.update(CAMERA_SHOWN);
    callService.onAction(new Disposable().signal, vi.fn());
    await settle();
    expect(host.invoke).not.toHaveBeenCalled();
    expect(host.listen).not.toHaveBeenCalled();
  });

  it("swallows a refused start, and still sends what follows", async () => {
    host.invoke.mockRejectedValueOnce("call service: not allowed from background");
    const callService = await load();
    expect(() => callService.update(JOINED)).not.toThrow();
    callService.update(LEFT);
    await settle();
    expect(sent()).toEqual([JOINED, LEFT]);
    expect(host.warn).toHaveBeenCalledWith(
      "Call service refused; the call may stop in the background",
      "call service: not allowed from background",
    );
  });

  it.each([
    { mic: "live", text: "In a call", micLabel: "Mute" },
    { mic: "muted", text: "In a call, muted", micLabel: "Unmute" },
    // A moderator's mute is not the member's to lift: no button for it.
    { mic: "locked", text: "In a call, muted by a moderator", micLabel: null },
  ] as const)("words the notification for a $mic microphone", async (face) => {
    const callService = await load();
    callService.update({ ...CAMERA_ON, mic: face.mic });
    await settle();
    expect(sentArgs()).toEqual([
      { active: true, camera: true, videoOnScreen: false, face: { ...face, leaveLabel: "Leave" } },
    ]);
  });
});

describe("the call notifications' buttons", () => {
  let owner: Disposable;
  /** The plugin's `action` event, as each listener registered for it. */
  let registered: ((raw: unknown) => void)[];
  const heard = vi.fn<(action: CallAction) => void>();

  /** Listen with `signal` and wait until the host has the listener. */
  async function follow(signal: AbortSignal, handler = heard): Promise<void> {
    (await load()).onAction(signal, handler);
    await settle();
  }

  beforeEach(() => {
    owner = new Disposable();
    registered = [];
    host.unregister.mockResolvedValue(undefined);
    host.listen.mockImplementation((_plugin, _event, onEvent: (raw: unknown) => void) => {
      registered.push(onEvent);
      return Promise.resolve({ unregister: host.unregister });
    });
  });
  afterEach(() => owner.destroy());

  it.each<CallAction>([
    { kind: "mute" },
    { kind: "unmute" },
    { kind: "leave" },
    { kind: "accept", channelId: 7 },
    { kind: "decline", channelId: 7 },
    { kind: "open", channelId: 7 },
  ])("pass on a pressed $kind, and nothing the contract does not name", async (action) => {
    await follow(owner.signal);
    expect(host.listen).toHaveBeenCalledWith(
      "owncord-call-service",
      "action",
      expect.any(Function),
    );
    registered[0]!({ channelId: 3, ...action, token: "t" });
    expect(heard.mock.calls).toEqual([[action]]);
  });

  it.each([
    ["a bare word", "mute"],
    ["nothing", null],
    ["a button nobody has", { kind: "hold" }],
    ["a ring's button without its conversation", { kind: "accept" }],
    ["a conversation that is not a number", { kind: "decline", channelId: "7" }],
  ])("drop %s, with a warning", async (_what, raw) => {
    await follow(owner.signal);
    registered[0]!(raw);
    expect(heard).not.toHaveBeenCalled();
    expect(host.warn).toHaveBeenCalledWith("Unknown call notification button");
  });

  it("stop with their owner", async () => {
    await follow(owner.signal);
    owner.destroy();
    await settle();
    expect(host.unregister).toHaveBeenCalledOnce();
    // An event the host had on its way as the listener went.
    registered[0]!({ kind: "leave" });
    expect(heard).not.toHaveBeenCalled();
  });

  it("leave no listener behind for an owner gone before it was in", async () => {
    const listening = createDeferred<{ unregister: () => Promise<void> }>();
    host.listen.mockReturnValue(listening.promise);
    await follow(owner.signal);
    owner.destroy();
    expect(host.unregister).not.toHaveBeenCalled();

    listening.resolve({ unregister: host.unregister });
    await settle();
    expect(host.unregister).toHaveBeenCalledOnce();
  });

  it("go to the newest listener only, whose turn an ended older one does not end", async () => {
    const older = new Disposable();
    const olderHeard = vi.fn<(action: CallAction) => void>();
    await follow(older.signal, olderHeard);
    await follow(owner.signal);
    // The host tells every listener it still has.
    for (const tell of registered) tell({ kind: "leave" });
    expect(olderHeard).not.toHaveBeenCalled();
    expect(heard).toHaveBeenCalledOnce();

    older.destroy();
    await settle();
    expect(host.unregister).toHaveBeenCalledOnce();
    registered[1]!({ kind: "mute" });
    expect(heard).toHaveBeenLastCalledWith({ kind: "mute" });
  });

  it("stay with the listener that has them when an owner already gone asks", async () => {
    await follow(owner.signal);
    const gone = new Disposable();
    gone.destroy();
    const late = vi.fn<(action: CallAction) => void>();
    await follow(gone.signal, late);
    expect(host.listen).toHaveBeenCalledOnce();
    registered[0]!({ kind: "leave" });
    expect(heard).toHaveBeenCalledOnce();
    expect(late).not.toHaveBeenCalled();
  });

  it("are deaf, with a warning, on a host that will not listen", async () => {
    const refusal = new Error("plugin not found");
    host.listen.mockRejectedValue(refusal);
    await follow(owner.signal);
    expect(host.warn).toHaveBeenCalledWith("Call notification buttons unavailable", refusal);
    expect(heard).not.toHaveBeenCalled();
  });
});
