import { describe, it, expect, beforeEach, vi } from "vitest";

const fetchImageAsDataUrl = vi.hoisted(() => vi.fn());

// The real module reaches for the Tauri HTTP plugin and IndexedDB; only the
// fetch entry point matters here, so it is stubbed and the URL helpers are
// kept honest by reimplementing exactly what they do.
vi.mock("@components/message-list/attachments", () => ({
  fetchImageAsDataUrl,
  isSafeUrl: (url: string) => url.startsWith("https://") || url.startsWith("http://"),
  resolveServerUrl: (url: string) => (url.startsWith("http") ? url : `https://server.test${url}`),
}));

const { avatarInitial, createAvatarElement, isRenderableAvatar, resolveDisplayName } =
  await import("@lib/avatar");

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
    fetchImageAsDataUrl.mockReset();
  });

  it("renders the letter fallback synchronously", () => {
    fetchImageAsDataUrl.mockResolvedValue(null);
    const el = createAvatarElement(
      { username: "ada", avatar: null },
      { className: "msg-avatar", background: "red" },
    );
    expect(el.className).toBe("msg-avatar");
    expect(el.textContent).toBe("A");
    expect(el.style.background).toBe("red");
    expect(fetchImageAsDataUrl).not.toHaveBeenCalled();
  });

  it("never fetches for a deleted account", () => {
    createAvatarElement(
      { username: "gone", avatar: "/api/v1/files/x", isDeleted: true },
      {
        className: "msg-avatar",
      },
    );
    expect(fetchImageAsDataUrl).not.toHaveBeenCalled();
  });

  it("swaps in the fetched image once the bytes arrive", async () => {
    fetchImageAsDataUrl.mockResolvedValue("data:image/png;base64,AAA");
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
    expect(fetchImageAsDataUrl).toHaveBeenCalledWith("https://server.test/api/v1/files/abc");

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
    fetchImageAsDataUrl.mockResolvedValue(null);
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
    fetchImageAsDataUrl.mockResolvedValue("data:image/png;base64,AAA");
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
