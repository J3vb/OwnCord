/**
 * The video grid loads on first use (O-6c). Each test builds a fresh module
 * graph so the grid's import can be held open and released.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  gate: null as null | { promise: Promise<void>; open: () => void; fail: () => void },
  loads: { value: 0 },
  calls: [] as string[],
  grids: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  throwOnce: false,
  errors: [] as unknown[],
}));

vi.mock("@lib/toast", () => ({ showToast: vi.fn() }));

// The real logger registers a window listener at load; each test reloads the
// graph, so keep it out of the way.
vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => h.errors.push(args),
  }),
}));

vi.mock("@lib/voice/livekitSession", () => ({
  muteScreenshareAudio: vi.fn(),
  setScreenshareAudioVolume: vi.fn(),
  setUserVolume: vi.fn(),
  getScreenshareAudioMuted: vi.fn(() => false),
  getScreenshareAudioVolume: vi.fn(() => 1),
  getUserVolume: vi.fn(() => 100),
  getUserLocalMute: vi.fn(() => false),
  setUserLocalMute: vi.fn(),
}));

import type { LazyVideoGrid } from "../../src/pages/main-page/lazyVideoGrid";
import type { VideoGridCallbacks, TileConfig } from "../../src/components/VideoGrid";

type LazyModule = typeof import("../../src/pages/main-page/lazyVideoGrid");

function makeGate(): NonNullable<typeof h.gate> {
  let open!: () => void;
  let fail!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = () => reject(new Error("chunk load failed"));
  });
  promise.catch(() => {});
  return { promise, open, fail };
}

function stream(): MediaStream {
  return { getTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;
}

const METHODS = [
  "mount",
  "destroy",
  "addStream",
  "watch",
  "setLabel",
  "removeStream",
  "clearStreams",
  "setFocusedTile",
  "setPeople",
  "setSpeaking",
  "setUserAudioState",
  "setCallbacks",
  "setCallState",
  "setExitVisible",
  "showMiniPlayer",
  "hideMiniPlayer",
] as const;

/** A recording stand-in for the real grid; every call lands in `h.calls`. */
function fakeGrid(): Record<string, ReturnType<typeof vi.fn>> {
  const grid: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of METHODS) {
    grid[name] = vi.fn((...args: unknown[]) => {
      h.calls.push(
        `${name}(${args
          .map((a) =>
            typeof a === "number" || typeof a === "string" || typeof a === "boolean"
              ? String(a)
              : "·",
          )
          .join(",")})`,
      );
    });
  }
  grid.hasStreams = vi.fn(() => true);
  grid.getFocusedTileId = vi.fn(() => 7);
  grid.raiseCallPopout = vi.fn(() => true);
  return grid;
}

async function gatedFactory(): Promise<object> {
  h.loads.value += 1;
  await h.gate!.promise;
  return {
    createVideoGrid: () => {
      if (h.throwOnce) {
        h.throwOnce = false;
        throw new Error("grid failed to start");
      }
      const g = fakeGrid();
      h.grids.push(g);
      return g;
    },
  };
}

describe("createLazyVideoGrid", () => {
  let lazy: LazyModule;
  let toast: typeof import("@lib/toast");
  let grid: LazyVideoGrid;
  let slot: HTMLDivElement;

  beforeEach(async () => {
    vi.resetModules();
    h.gate = makeGate();
    h.loads.value = 0;
    h.calls.length = 0;
    h.grids.length = 0;
    h.errors.length = 0;
    h.throwOnce = false;
    vi.doMock("@components/VideoGrid", gatedFactory);
    lazy = await import("../../src/pages/main-page/lazyVideoGrid");
    toast = await import("@lib/toast");
    vi.mocked(toast.showToast).mockClear();
    grid = lazy.createLazyVideoGrid();
    slot = document.createElement("div");
  });
  afterEach(() => {
    grid.destroy?.();
    vi.doUnmock("@components/VideoGrid");
  });

  const loaded = async (): Promise<void> => {
    h.gate!.open();
    await vi.waitFor(() => expect(h.grids.length).toBe(1));
  };
  const config = (extra: Partial<TileConfig> = {}): TileConfig => ({
    isSelf: false,
    audioUserId: 1,
    isScreenshare: false,
    ...extra,
  });

  it("does not import the grid until a trigger", async () => {
    grid.mount(slot);
    grid.setCallbacks({});
    grid.setCallState({ muted: false, deafened: false, listenOnly: false });
    grid.setSpeaking(new Set([1]));
    grid.setUserAudioState(new Map());
    grid.setPeople([]);
    grid.setExitVisible(false);
    grid.setFocusedTile(null);
    grid.removeStream(3);
    grid.clearStreams();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.loads.value).toBe(0);
  });

  it("each backstop trigger starts the import", async () => {
    const people = [{ userId: 1, label: "a", content: document.createElement("div") }];
    const triggers: Array<(g: LazyVideoGrid) => void> = [
      (g) => g.ensureLoaded(),
      (g) => g.addStream(1, "a", null, config()),
      (g) => g.watch(2),
      (g) => g.setPeople(people),
      (g) => g.setExitVisible(true),
      (g) => g.setFocusedTile(4),
    ];
    for (const trigger of triggers) {
      vi.resetModules();
      h.loads.value = 0;
      const fresh = (await import("../../src/pages/main-page/lazyVideoGrid")).createLazyVideoGrid();
      trigger(fresh);
      await vi.waitFor(() => expect(h.loads.value).toBe(1));
      fresh.destroy?.();
    }
  });

  it("replays streams in insertion order with the latest stream, config and label", async () => {
    const s1 = stream();
    const s2 = stream();
    const s3 = stream();
    grid.mount(slot);
    grid.addStream(5, "five", stream(), config());
    grid.addStream(6, "six", s2, config());
    grid.addStream(5, "five-b", s1, config({ name: "Five" }));
    grid.setLabel(6, "six-renamed", "Six");
    grid.addStream(7, "seven", s3, config());
    await loaded();
    expect(h.calls).toEqual([
      "mount(·)",
      "addStream(5,five-b,·,·)",
      "addStream(6,six,·,·)",
      "setLabel(6,six-renamed,Six)",
      "addStream(7,seven,·,·)",
    ]);
    const g = h.grids[0]!;
    expect(g.addStream!.mock.calls[0]![2]).toBe(s1);
    expect(g.addStream!.mock.calls[0]![3]).toMatchObject({ name: "Five" });
  });

  it("a stream added and removed before load is never drawn", async () => {
    grid.addStream(5, "five", stream(), config());
    grid.addStream(6, "six", stream(), config());
    grid.removeStream(5);
    expect(grid.hasStreams()).toBe(true);
    await loaded();
    expect(h.calls).toEqual(["addStream(6,six,·,·)"]);
  });

  it("a null stream replaced by a watched stream before load replays the watched stream", async () => {
    const watched = stream();
    grid.addStream(5, "five", null, config());
    grid.addStream(5, "five", watched, config());
    await loaded();
    expect(h.grids[0]!.addStream).toHaveBeenCalledTimes(1);
    expect(h.grids[0]!.addStream!.mock.calls[0]![2]).toBe(watched);
  });

  it("clearStreams before load drops earlier tiles and forgets pending watches (edge 1)", async () => {
    const forget = vi.fn();
    const watched = vi.fn();
    const cb: VideoGridCallbacks = { forgetStreamWatch: forget, setStreamWatched: watched };
    grid.setCallbacks(cb);
    grid.addStream(1, "a", stream(), config({ audioUserId: 1 })); // stream A, channel 1
    grid.watch(9); // a pending watch, no tile yet
    grid.clearStreams(); // switch to channel 2
    grid.addStream(2, "b", stream(), config({ audioUserId: 2 })); // stream B
    expect(forget).toHaveBeenCalledWith(1);
    expect(forget).toHaveBeenCalledWith(9);
    expect(grid.hasStreams()).toBe(true);
    await loaded();
    expect(h.calls).toEqual(["setCallbacks(·)", "addStream(2,b,·,·)"]);
    // A's and 9's watches were forgotten before load and are not asked for again.
    expect(watched).toHaveBeenCalledTimes(1);
    expect(watched).toHaveBeenCalledWith(9, true);
  });

  it("destroy during load creates and mounts nothing (edge 2)", async () => {
    const cb = { setStreamWatched: vi.fn() };
    grid.mount(slot);
    grid.setCallbacks(cb);
    grid.addStream(5, "five", stream(), config());
    await vi.waitFor(() => expect(h.loads.value).toBe(1));
    grid.destroy?.();
    h.gate!.open();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.grids).toHaveLength(0);
    expect(h.calls).toEqual([]);
    expect(grid.hasStreams()).toBe(false);
    // A trigger on a dead proxy starts no import.
    grid.ensureLoaded();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.loads.value).toBe(1);
  });

  it("destroy after load destroys the grid", async () => {
    grid.addStream(5, "five", stream(), config());
    await loaded();
    grid.destroy?.();
    expect(h.grids[0]!.destroy).toHaveBeenCalledTimes(1);
  });

  it("watch before load asks setStreamWatched at once and replays watch after addStream", async () => {
    const watched = vi.fn();
    grid.setCallbacks({ setStreamWatched: watched });
    grid.watch(9);
    expect(watched).toHaveBeenCalledWith(9, true);
    expect(watched).toHaveBeenCalledTimes(1);
    await loaded();
    expect(h.calls).toEqual(["setCallbacks(·)", "watch(9)"]);
  });

  it("a tile that arrives before load consumes its pending watch", async () => {
    grid.setCallbacks({ setStreamWatched: vi.fn() });
    grid.watch(9);
    grid.addStream(9, "nine", stream(), config());
    await loaded();
    expect(h.calls).toEqual(["setCallbacks(·)", "addStream(9,nine,·,·)"]);
  });

  it("getters answer from recorded state before load", () => {
    expect(grid.hasStreams()).toBe(false);
    expect(grid.getFocusedTileId()).toBeNull();
    expect(grid.raiseCallPopout()).toBe(false);
    grid.showMiniPlayer();
    grid.hideMiniPlayer();
    grid.addStream(5, "five", null, config());
    grid.setFocusedTile(5);
    expect(grid.hasStreams()).toBe(true);
    expect(grid.getFocusedTileId()).toBe(5);
    expect(h.calls).toEqual([]);
  });

  it("setCallbacks is replayed before the first addStream, and focus and watches come last", async () => {
    grid.addStream(5, "five", stream(), config());
    grid.setFocusedTile(5);
    grid.watch(8);
    grid.setCallbacks({});
    grid.setCallState({ muted: true, deafened: false, listenOnly: false });
    grid.setExitVisible(true);
    grid.setSpeaking(new Set([5]));
    grid.setUserAudioState(new Map());
    await loaded();
    expect(h.calls).toEqual([
      "setCallbacks(·)",
      "setCallState(·)",
      "setExitVisible(true)",
      "setUserAudioState(·)",
      "setSpeaking(·)",
      "addStream(5,five,·,·)",
      "setFocusedTile(5)",
      "watch(8)",
    ]);
  });

  it("forwards directly after load and keeps no copy", async () => {
    grid.addStream(5, "five", stream(), config());
    await loaded();
    h.calls.length = 0;
    grid.addStream(6, "six", stream(), config());
    grid.removeStream(5);
    grid.clearStreams();
    expect(h.calls).toEqual(["addStream(6,six,·,·)", "removeStream(5)", "clearStreams()"]);
    expect(grid.hasStreams()).toBe(true); // the real grid answers
    expect(grid.getFocusedTileId()).toBe(7);
    expect(grid.raiseCallPopout()).toBe(true);
    // No second grid, no second import.
    grid.ensureLoaded();
    expect(h.loads.value).toBe(1);
    expect(h.grids).toHaveLength(1);
  });

  it("a failed import keeps state, toasts once, and the next trigger retries and replays", async () => {
    grid.mount(slot);
    grid.addStream(5, "five", stream(), config());
    h.gate!.fail();
    await vi.waitFor(() => expect(toast.showToast).toHaveBeenCalledTimes(1));
    expect(h.grids).toHaveLength(0);
    expect(grid.hasStreams()).toBe(true);

    h.gate = makeGate();
    vi.doMock("@components/VideoGrid", gatedFactory);
    grid.ensureLoaded();
    await vi.waitFor(() => expect(h.loads.value).toBe(2));
    await loaded();
    expect(h.calls).toEqual(["mount(·)", "addStream(5,five,·,·)"]);
    expect(toast.showToast).toHaveBeenCalledTimes(1);
  });

  it("after a failed import, track and roster events do not retry or toast again", async () => {
    grid.addStream(5, "five", stream(), config());
    h.gate!.fail();
    await vi.waitFor(() => expect(toast.showToast).toHaveBeenCalledTimes(1));
    h.gate = makeGate();
    const people = [{ userId: 1, label: "a", content: document.createElement("div") }];
    for (let i = 0; i < 3; i++) {
      grid.setPeople(people);
      grid.addStream(6 + i, "x", stream(), config());
      grid.setFocusedTile(5);
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(h.loads.value).toBe(1);
    expect(toast.showToast).toHaveBeenCalledTimes(1);

    // A join tries again.
    vi.doMock("@components/VideoGrid", gatedFactory);
    grid.ensureLoaded();
    await vi.waitFor(() => expect(h.loads.value).toBe(2));
    await loaded();
    expect(h.grids).toHaveLength(1);
  });

  it("a user's watch after a failed import tries again", async () => {
    h.gate!.fail();
    grid.watch(3);
    await vi.waitFor(() => expect(toast.showToast).toHaveBeenCalledTimes(1));
    h.gate = makeGate();
    vi.doMock("@components/VideoGrid", gatedFactory);
    grid.watch(3);
    await vi.waitFor(() => expect(h.loads.value).toBe(2));
  });

  it("a grid that throws while starting is logged, keeps state, and the next trigger loads", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    grid.mount(slot);
    grid.addStream(5, "five", stream(), config());
    h.throwOnce = true;
    h.gate!.open();
    await vi.waitFor(() => expect(h.errors).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(h.grids).toHaveLength(0);
    expect(grid.hasStreams()).toBe(true);

    grid.ensureLoaded();
    await vi.waitFor(() => expect(h.grids).toHaveLength(1));
    expect(h.calls).toEqual(["mount(·)", "addStream(5,five,·,·)"]);
  });

  it("replays a stream whose video track ended as a tile without a stream", async () => {
    const dead = {
      getTracks: () => [],
      getVideoTracks: () => [{ readyState: "ended" }],
    } as unknown as MediaStream;
    const live = {
      getTracks: () => [],
      getVideoTracks: () => [{ readyState: "live" }],
    } as unknown as MediaStream;
    grid.addStream(5, "five", dead, config());
    grid.addStream(6, "six", live, config());
    await loaded();
    const calls = h.grids[0]!.addStream!.mock.calls;
    expect(calls[0]![2]).toBeNull();
    expect(calls[1]![2]).toBe(live);
  });

  it("mount after load mounts the real grid", async () => {
    grid.ensureLoaded();
    await loaded();
    grid.mount(slot);
    expect(h.calls).toEqual(["mount(·)"]);
  });
});

describe("parity with the real grid", () => {
  /** One scripted sequence of grid calls, the way MainPage and the call panel make them. */
  function script(g: LazyVideoGrid | import("../../src/components/VideoGrid").VideoGridComponent) {
    const content = (): HTMLElement => {
      const el = document.createElement("div");
      el.textContent = "avatar";
      return el;
    };
    const cfg = (id: number, extra: Partial<TileConfig> = {}): TileConfig => ({
      isSelf: false,
      audioUserId: id,
      isScreenshare: false,
      ...extra,
    });
    g.setCallbacks({});
    g.setCallState({ muted: true, deafened: false, listenOnly: false });
    g.setPeople([
      { userId: 3, label: "carol", content: content() },
      { userId: 4, label: "dave", content: content() },
    ]);
    g.addStream(1, "alice", stream(), cfg(1));
    g.addStream(2, "bob", stream(), cfg(2, { name: "Bob" }));
    g.addStream(3, "carol", stream(), cfg(3));
    g.setLabel(2, "robert", "Robert");
    g.removeStream(3);
    g.setFocusedTile(2);
    g.setSpeaking(new Set([1]));
    g.setUserAudioState(new Map([[1, { muted: true, deafened: false }]]));
  }

  /** The tile ids, labels, focus and badges, from the DOM. Class tokens are
   *  compared as sets: the order a class is added in is not drawn. */
  function summary(root: Element): { cells: unknown[]; html: string } {
    const grid = root.querySelector(".video-grid")!.cloneNode(true) as Element;
    for (const el of [grid, ...grid.querySelectorAll("[class]")]) {
      el.setAttribute("class", [...el.classList].sort().join(" "));
    }
    return {
      cells: [...grid.querySelectorAll(".video-cell")].map((el) => ({
        cls: el.className,
        user: el.getAttribute("data-user-id") ?? el.getAttribute("data-person-id"),
        label: el.querySelector(".video-username")?.textContent,
        badge: el.querySelector("[data-testid='tile-audio-state']")?.className ?? null,
      })),
      html: grid.outerHTML,
    };
  }

  beforeEach(() => {
    // jsdom has no ResizeObserver; the real grid watches its root with one.
    globalThis.ResizeObserver ??= class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.resetModules();
    h.gate = makeGate();
    vi.doMock("@components/VideoGrid", async () => {
      await h.gate!.promise;
      return await vi.importActual<object>("@components/VideoGrid");
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("@components/VideoGrid");
  });

  it("draws the same tiles, labels, focus and badges as the real grid", async () => {
    const actual =
      await vi.importActual<typeof import("../../src/components/VideoGrid")>(
        "@components/VideoGrid",
      );
    const directSlot = document.createElement("div");
    document.body.appendChild(directSlot);
    const direct = actual.createVideoGrid();
    direct.mount(directSlot);
    script(direct);

    const { createLazyVideoGrid } = await import("../../src/pages/main-page/lazyVideoGrid");
    const proxy = createLazyVideoGrid();
    const proxySlot = document.createElement("div");
    document.body.appendChild(proxySlot);
    proxy.mount(proxySlot);
    script(proxy);
    expect(proxySlot.querySelector(".video-grid")).toBeNull(); // held: nothing drawn yet
    h.gate!.open();
    await vi.waitFor(() => expect(proxySlot.querySelector(".video-grid")).not.toBeNull());

    const want = summary(directSlot);
    const got = summary(proxySlot);
    expect(want.cells.length).toBe(4); // alice and robert, then carol (camera removed) and dave as avatars
    expect(got.cells).toEqual(want.cells);
    expect(got.html === want.html).toBe(true);
    expect(proxy.getFocusedTileId()).toBe(direct.getFocusedTileId());
    expect(proxy.hasStreams()).toBe(direct.hasStreams());

    direct.destroy?.();
    proxy.destroy?.();
    directSlot.remove();
    proxySlot.remove();
  });

  it("draws the same call view when a watched null tile gets its stream before load", async () => {
    const actual =
      await vi.importActual<typeof import("../../src/components/VideoGrid")>(
        "@components/VideoGrid",
      );
    const callbacks = {
      callControls: { onMuteToggle: vi.fn(), onDeafenToggle: vi.fn(), onLeave: vi.fn() },
      setStreamWatched: vi.fn(),
      forgetStreamWatch: vi.fn(),
    };
    const run = (
      g: LazyVideoGrid | import("../../src/components/VideoGrid").VideoGridComponent,
    ): void => {
      g.setCallbacks(callbacks);
      g.setCallState({ muted: false, deafened: false, listenOnly: false });
      g.setExitVisible(true);
      const cfg: TileConfig = { isSelf: false, audioUserId: 2, isScreenshare: false };
      g.addStream(2, "bob", null, cfg); // offered, not watched
      g.watch(2);
      g.addStream(2, "bob", stream(), cfg); // its stream arrives
    };
    const directSlot = document.createElement("div");
    document.body.appendChild(directSlot);
    const direct = actual.createVideoGrid();
    direct.mount(directSlot);
    run(direct);

    const { createLazyVideoGrid } = await import("../../src/pages/main-page/lazyVideoGrid");
    const proxy = createLazyVideoGrid();
    const proxySlot = document.createElement("div");
    document.body.appendChild(proxySlot);
    proxy.mount(proxySlot);
    run(proxy);
    h.gate!.open();
    await vi.waitFor(() => expect(proxySlot.querySelector(".video-grid")).not.toBeNull());

    const want = summary(directSlot);
    const got = summary(proxySlot);
    expect(want.cells.length).toBe(1);
    expect(got.cells).toEqual(want.cells);
    expect(got.html === want.html).toBe(true);

    direct.destroy?.();
    proxy.destroy?.();
    directSlot.remove();
    proxySlot.remove();
  });
});
