import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const fetchImageAsObjectUrl = vi.hoisted(() => vi.fn());
const cachedImageBytes = vi.hoisted(() =>
  vi.fn((): (() => Promise<Uint8Array | null>) | null => null),
);

// The real module reaches for the Tauri HTTP plugin and IndexedDB; only the
// fetch entry point matters here, so it is stubbed and the URL helpers are
// kept honest by reimplementing exactly what they do.
vi.mock("@components/message-list/attachments", () => ({
  fetchImageAsObjectUrl,
  cachedImageBytes,
  recoverEvictedImage: () => {},
  isSafeUrl: (url: string) => url.startsWith("https://") || url.startsWith("http://"),
  resolveServerUrl: (url: string) => (url.startsWith("http") ? url : `https://server.test${url}`),
}));

const { avatarInitial, resolveDisplayName } = await import("@lib/avatar");
const { createAvatarElement, isRenderableAvatar } =
  await import("../../src/components/message-list/avatar");
const { clearAnimatedStills } = await import("@lib/animatedStill");

describe("resolveDisplayName", () => {
  it("prefers the display name when there is one", () => {
    expect(resolveDisplayName({ username: "ada", displayName: "Ada L." })).toBe("Ada L.");
  });

  it("falls back to the username when the display name is absent, null or blank", () => {
    expect(resolveDisplayName({ username: "ada" })).toBe("ada");
    expect(resolveDisplayName({ username: "ada", displayName: null })).toBe("ada");
    // Whitespace is not a name — the server trims, but an older row might not.
    expect(resolveDisplayName({ username: "ada", displayName: "   " })).toBe("ada");
  });
});

describe("avatarInitial", () => {
  it("takes the first letter of the rendered name", () => {
    expect(avatarInitial({ username: "ada", displayName: "Zoe" })).toBe("Z");
    expect(avatarInitial({ username: "ada" })).toBe("A");
  });

  it("renders a deleted account as ?", () => {
    expect(avatarInitial({ username: "gone", isDeleted: true })).toBe("?");
  });

  it("falls back to ? for a name with no letter to take", () => {
    expect(avatarInitial({ username: "" })).toBe("?");
  });
});

describe("isRenderableAvatar", () => {
  it("accepts server-relative and https URLs", () => {
    expect(isRenderableAvatar("/api/v1/files/abc")).toBe(true);
    expect(isRenderableAvatar("https://cdn.example/pic.png")).toBe(true);
  });

  it("rejects nothing-to-render and unsafe schemes", () => {
    expect(isRenderableAvatar(null)).toBe(false);
    expect(isRenderableAvatar(undefined)).toBe(false);
    expect(isRenderableAvatar("")).toBe(false);
    // javascript:/data: are not avatars, and an <img> pointed at one is a
    // liability rather than a picture.
    expect(isRenderableAvatar("javascript:alert(1)")).toBe(false);
  });
});

describe("createAvatarElement", () => {
  beforeEach(() => {
    fetchImageAsObjectUrl.mockReset();
  });

  it("renders the letter fallback synchronously", () => {
    fetchImageAsObjectUrl.mockResolvedValue(null);
    const el = createAvatarElement(
      { username: "ada", avatar: null },
      { className: "msg-avatar", background: "red" },
    );
    expect(el.className).toBe("msg-avatar");
    expect(el.textContent).toBe("A");
    expect(el.style.background).toBe("red");
    expect(fetchImageAsObjectUrl).not.toHaveBeenCalled();
  });

  it("never fetches for a deleted account", () => {
    createAvatarElement(
      { username: "gone", avatar: "/api/v1/files/x", isDeleted: true },
      {
        className: "msg-avatar",
      },
    );
    expect(fetchImageAsObjectUrl).not.toHaveBeenCalled();
  });

  it("swaps in the fetched image once the bytes arrive", async () => {
    fetchImageAsObjectUrl.mockResolvedValue("data:image/png;base64,AAA");
    const el = createAvatarElement(
      { username: "ada", displayName: "Ada L.", avatar: "/api/v1/files/abc" },
      { className: "mi-avatar" },
    );
    // Attached, because the helper skips a swap into an element nobody is
    // looking at.
    document.body.appendChild(el);
    // The letter is what renders in the meantime.
    expect(el.textContent).toBe("A");

    // The authenticated file route is resolved against the server host — the
    // helper must not hand a relative URL to the fetcher.
    expect(fetchImageAsObjectUrl).toHaveBeenCalledWith("https://server.test/api/v1/files/abc");

    await vi.waitFor(() => {
      const img = el.querySelector("img");
      expect(img).not.toBeNull();
      expect(img?.getAttribute("src")).toBe("data:image/png;base64,AAA");
      // Alt text is the name the reader sees, not the raw username.
      expect(img?.getAttribute("alt")).toBe("Ada L.");
    });
    // The letter is removed rather than hidden, so it leaves the a11y tree.
    expect(el.querySelector(".avatar-initial")).toBeNull();
    el.remove();
  });

  it("keeps the letter when the fetch fails", async () => {
    fetchImageAsObjectUrl.mockResolvedValue(null);
    const el = createAvatarElement(
      { username: "ada", avatar: "/api/v1/files/abc" },
      { className: "mi-avatar" },
    );
    document.body.appendChild(el);
    await Promise.resolve();
    await Promise.resolve();
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toBe("A");
    el.remove();
  });

  it("does not swap into a detached element", async () => {
    fetchImageAsObjectUrl.mockResolvedValue("data:image/png;base64,AAA");
    const el = createAvatarElement(
      { username: "ada", avatar: "/api/v1/files/abc" },
      { className: "mi-avatar" },
    );
    // Never attached — the row was torn down while the fetch was in flight.
    await Promise.resolve();
    await Promise.resolve();
    expect(el.querySelector("img")).toBeNull();
  });
});

describe("createAvatarElement with deferUntilVisible", () => {
  type Callback = (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
  let callback: Callback | null;
  let observed: Set<Element>;
  let constructed: number;

  class FakeObserver {
    constructor(cb: Callback) {
      callback = cb;
      constructed++;
    }
    observe(el: Element): void {
      observed.add(el);
    }
    unobserve(el: Element): void {
      observed.delete(el);
    }
  }

  // The observer and the limiter are module state, so each test gets a fresh
  // copy of the module.
  async function load(): Promise<typeof import("../../src/components/message-list/avatar")> {
    vi.resetModules();
    return import("../../src/components/message-list/avatar");
  }

  function mount(create: typeof createAvatarElement, n: number, attach = true): HTMLDivElement {
    const el = create(
      { username: `u${n}`, avatar: `/api/v1/files/${n}` },
      { className: "mi-avatar", deferUntilVisible: true },
    );
    if (attach) document.body.appendChild(el);
    return el;
  }

  function show(el: Element): void {
    callback?.([{ target: el, isIntersecting: true }]);
  }

  beforeEach(() => {
    fetchImageAsObjectUrl.mockReset();
    callback = null;
    observed = new Set();
    constructed = 0;
    document.body.innerHTML = "";
    vi.stubGlobal("IntersectionObserver", FakeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches only once the wrapper becomes visible, then stops observing", async () => {
    fetchImageAsObjectUrl.mockResolvedValue("data:image/png;base64,AAA");
    const { createAvatarElement: create } = await load();
    const el = mount(create, 1);
    expect(observed.has(el)).toBe(true);
    expect(fetchImageAsObjectUrl).not.toHaveBeenCalled();

    callback?.([{ target: el, isIntersecting: false }]);
    expect(fetchImageAsObjectUrl).not.toHaveBeenCalled();

    show(el);
    expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(1);
    expect(fetchImageAsObjectUrl).toHaveBeenCalledWith("https://server.test/api/v1/files/1");
    expect(observed.has(el)).toBe(false);
    await vi.waitFor(() => expect(el.querySelector("img")).not.toBeNull());
  });

  it("shares one observer across avatars", async () => {
    const { createAvatarElement: create } = await load();
    mount(create, 1);
    mount(create, 2);
    expect(constructed).toBe(1);
    expect(observed.size).toBe(2);
  });

  it("runs at most 6 fetches at once and starts the next when one settles", async () => {
    const settlers: Array<(value: string | null) => void> = [];
    fetchImageAsObjectUrl.mockImplementation(
      () => new Promise<string | null>((resolve) => settlers.push(resolve)),
    );
    const { createAvatarElement: create } = await load();
    const els = Array.from({ length: 7 }, (_, i) => mount(create, i));
    for (const el of els) show(el);

    expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(6);

    settlers[0]?.(null);
    await vi.waitFor(() => expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(7));
    expect(fetchImageAsObjectUrl).toHaveBeenLastCalledWith("https://server.test/api/v1/files/6");
    for (const settle of settlers) settle(null);
  });

  it("frees a slot when a fetch fails or throws", async () => {
    let calls = 0;
    fetchImageAsObjectUrl.mockImplementation(() => {
      calls++;
      if (calls === 1) throw new Error("sync failure");
      if (calls <= 7) return Promise.reject(new Error("network"));
      return Promise.resolve(null);
    });
    const { createAvatarElement: create } = await load();
    const els = Array.from({ length: 8 }, (_, i) => mount(create, i));
    for (const el of els) show(el);

    await vi.waitFor(() => expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(8));
  });

  it("starts no fetch for a wrapper removed before it became visible", async () => {
    fetchImageAsObjectUrl.mockResolvedValue(null);
    const { createAvatarElement: create } = await load();
    const gone = mount(create, 1);
    const kept = mount(create, 2);
    gone.remove();

    // Any later report sweeps the detached wrapper out of the observer.
    show(kept);
    expect(observed.has(gone)).toBe(false);
    expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(1);
    expect(fetchImageAsObjectUrl).toHaveBeenCalledWith("https://server.test/api/v1/files/2");
  });

  it("skips a wrapper removed while it waited behind the cap", async () => {
    const settlers: Array<(value: string | null) => void> = [];
    fetchImageAsObjectUrl.mockImplementation(
      () => new Promise<string | null>((resolve) => settlers.push(resolve)),
    );
    const { createAvatarElement: create } = await load();
    const els = Array.from({ length: 7 }, (_, i) => mount(create, i));
    for (const el of els) show(el);
    els[6]?.remove();

    settlers[0]?.(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(6);
    for (const settle of settlers) settle(null);
  });

  it("fetches right away, still capped, when IntersectionObserver is missing", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const settlers: Array<(value: string | null) => void> = [];
    fetchImageAsObjectUrl.mockImplementation(
      () => new Promise<string | null>((resolve) => settlers.push(resolve)),
    );
    const { createAvatarElement: create } = await load();
    for (let i = 0; i < 7; i++) mount(create, i);

    await vi.waitFor(() => expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(6));
    settlers[0]?.(null);
    await vi.waitFor(() => expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(7));
    for (const settle of settlers) settle(null);
  });

  it("leaves the default path ungated", async () => {
    fetchImageAsObjectUrl.mockResolvedValue(null);
    const { createAvatarElement: create } = await load();
    create({ username: "ada", avatar: "/api/v1/files/9" }, { className: "mi-avatar" });
    expect(fetchImageAsObjectUrl).toHaveBeenCalledTimes(1);
    expect(constructed).toBe(0);
  });
});

describe("createAvatarElement with an animated picture (WP 8.7)", () => {
  /** Two 1x1 frames: enough for the frame scan to call it animated. */
  const twoFrameGif = (): Uint8Array => {
    const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00];
    return new Uint8Array([
      ...[..."GIF89a"].map((c) => c.charCodeAt(0)),
      1,
      0,
      1,
      0,
      0,
      0,
      0,
      ...frame,
      ...frame,
      0x3b,
    ]);
  };
  const STILL = "data:image/png;base64,U1RJTEw=";
  /** Loads release one at a time, so a test can act while a still is drawn. */
  let loads: Array<() => void>;

  beforeEach(() => {
    fetchImageAsObjectUrl.mockReset();
    cachedImageBytes.mockReset();
    clearAnimatedStills();
    document.documentElement.classList.remove("reduced-motion");
    loads = [];
    class FakeImage {
      naturalWidth = 64;
      naturalHeight = 64;
      private onLoad: (() => void) | null = null;
      addEventListener(type: string, fn: () => void): void {
        if (type === "load") this.onLoad = fn;
      }
      set src(_value: string) {
        loads.push(() => this.onLoad?.());
      }
    }
    vi.stubGlobal("Image", FakeImage);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: () => {},
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(STILL);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("shows the first frame and plays while its message row is hovered", async () => {
    fetchImageAsObjectUrl.mockResolvedValue("blob:anim");
    cachedImageBytes.mockReturnValue(async () => twoFrameGif());
    const row = document.createElement("div");
    row.className = "message";
    const el = createAvatarElement(
      { username: "ada", avatar: "/api/v1/files/a" },
      { className: "msg-avatar" },
    );
    row.appendChild(el);
    document.body.appendChild(row);

    await vi.waitFor(() => expect(loads.length).toBe(1));
    // Nothing is inserted before the still exists: no flash of animation.
    expect(el.querySelector("img")).toBeNull();
    loads[0]!();
    await vi.waitFor(() => expect(el.querySelector("img")?.getAttribute("src")).toBe(STILL));

    row.dispatchEvent(new Event("pointerenter"));
    expect(el.querySelector("img")?.getAttribute("src")).toBe("blob:anim");
    row.dispatchEvent(new Event("pointerleave"));
    expect(el.querySelector("img")?.getAttribute("src")).toBe(STILL);
  });

  it("plays from the start in the profile popup, and stays still under reduced motion", async () => {
    fetchImageAsObjectUrl.mockResolvedValue("blob:anim");
    cachedImageBytes.mockReturnValue(async () => twoFrameGif());
    const popup = createAvatarElement(
      { username: "ada", avatar: "/api/v1/files/a" },
      { className: "upp-avatar", animate: "always" },
    );
    document.body.appendChild(popup);
    await vi.waitFor(() => expect(loads.length).toBe(1));
    loads[0]!();
    await vi.waitFor(() =>
      expect(popup.querySelector("img")?.getAttribute("src")).toBe("blob:anim"),
    );

    document.documentElement.classList.add("reduced-motion");
    const reduced = createAvatarElement(
      { username: "ada", avatar: "/api/v1/files/a" },
      { className: "upp-avatar", animate: "always" },
    );
    document.body.appendChild(reduced);
    // Same source and size: the still is already known.
    await vi.waitFor(() => expect(reduced.querySelector("img")?.getAttribute("src")).toBe(STILL));
  });

  it("drops the picture when its row went away while the still was being drawn", async () => {
    fetchImageAsObjectUrl.mockResolvedValue("blob:old");
    cachedImageBytes.mockReturnValue(async () => twoFrameGif());
    const el = createAvatarElement(
      { username: "ada", avatar: "/api/v1/files/old" },
      { className: "mi-avatar" },
    );
    document.body.appendChild(el);
    await vi.waitFor(() => expect(loads.length).toBe(1));
    // A user_update with a new avatar rebuilt the row meanwhile.
    el.remove();
    loads[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toBe("A");
  });

  it("shows a still picture as it is, with no hover binding", async () => {
    fetchImageAsObjectUrl.mockResolvedValue("blob:still");
    cachedImageBytes.mockReturnValue(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const el = createAvatarElement(
      { username: "ada", avatar: "/api/v1/files/s" },
      { className: "mi-avatar" },
    );
    document.body.appendChild(el);
    await vi.waitFor(() => expect(el.querySelector("img")?.getAttribute("src")).toBe("blob:still"));
    expect(loads.length).toBe(0);
    expect(el.querySelector("img")?.dataset["mediaSrc"]).toBeUndefined();
  });
});
