import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// Painting an existing avatar goes through the authenticated image fetch;
// stub just that call so the Remove avatar tests need no network.
vi.mock("../../src/features/messaging/content/attachments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/features/messaging/content/attachments")>();
  return { ...actual, fetchImageAsObjectUrl: vi.fn(() => Promise.resolve(null)) };
});

import {
  buildAccountTab,
  prepareBannerFile,
  validateAvatarFile,
} from "../../src/features/settings/AccountTab";
import { authStore } from "@stores/auth.store";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/net/serverCapabilities";
import { ApiClientError } from "@lib/api";
import * as imageCrop from "@lib/ui/imageCrop";
import type { SettingsOverlayOptions } from "../../src/features/settings/SettingsOverlay";
import { makeOverlayOptions } from "../helpers/settingsOverlayOptions";

/**
 * The Account tab's new job: edit the display name and about text, and upload
 * an avatar. The upload is validated locally against the same rules the server
 * enforces, so a picture that is going to be refused is refused before a
 * megabyte goes over the wire.
 */

function setUser(patch: Record<string, unknown>): void {
  authStore.setState(() => ({
    token: "tok",
    user: { id: 1, username: "alice", avatar: null, role: "member", ...patch } as never,
    serverName: "s",
    motd: null,
    isAuthenticated: true,
  }));
}

function makeOptions(overrides?: Partial<SettingsOverlayOptions>): SettingsOverlayOptions {
  return makeOverlayOptions({
    onUploadAvatar: vi.fn().mockResolvedValue("/api/v1/files/abc"),
    onEnableTotp: vi.fn().mockResolvedValue({ qr_uri: "", backup_codes: [] }),
    ...overrides,
  });
}

function build(opts: SettingsOverlayOptions): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  container.appendChild(buildAccountTab(opts, new AbortController().signal));
  return container;
}

describe("validateAvatarFile", () => {
  const ok = { width: 512, height: 512 };

  it("accepts a PNG, JPEG, WebP or GIF within the caps", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(validateAvatarFile({ size: 1000, type }, ok)).toBeNull();
    }
  });

  it("rejects a type the server refuses", () => {
    expect(validateAvatarFile({ size: 1000, type: "image/svg+xml" }, ok)).toBe(
      "Avatar must be a PNG, JPEG, WebP or GIF image.",
    );
    expect(validateAvatarFile({ size: 1000, type: "text/plain" }, ok)).not.toBeNull();
  });

  it("rejects a file over 2 MB", () => {
    expect(validateAvatarFile({ size: 2 * 1024 * 1024 + 1, type: "image/gif" }, ok)).toBe(
      "Avatar must be at most 2048 KB.",
    );
    // Exactly at the cap is fine.
    expect(validateAvatarFile({ size: 2 * 1024 * 1024, type: "image/gif" }, ok)).toBeNull();
  });

  it("rejects an image bigger than any surface renders", () => {
    expect(
      validateAvatarFile({ size: 1000, type: "image/png" }, { width: 2000, height: 100 }),
    ).toBe("Avatar must be at most 1024x1024 pixels.");
    expect(
      validateAvatarFile({ size: 1000, type: "image/png" }, { width: 1024, height: 1024 }),
    ).toBeNull();
  });

  it("rejects a file that could not be decoded at all", () => {
    expect(validateAvatarFile({ size: 1000, type: "image/png" }, null)).toMatch(
      /could not be read/,
    );
  });
});

describe("Account tab profile fields", () => {
  let container: HTMLDivElement;
  let ac: AbortController;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    ac = new AbortController();
  });

  afterEach(() => {
    ac.abort();
    container.remove();
  });

  /** Focus only lands on what is shown, so open the collapsed editor first. */
  /** Opens the profile editor over a save that stays pending until `settle` is called. */
  function openEditorWithHeldSave() {
    setUser({});
    let settle!: () => void;
    const options = makeOptions({
      onUpdateProfile: vi.fn(() => new Promise<void>((resolve) => (settle = resolve))),
    });
    container.appendChild(buildAccountTab(options, ac.signal));

    openProfileEditor();
    const save = container.querySelector<HTMLButtonElement>('[data-testid="profile-save-btn"]')!;
    return { settle: () => settle(), save };
  }

  function openProfileEditor(): void {
    container.querySelector<HTMLButtonElement>('[data-testid="profile-edit-toggle"]')!.click();
  }

  it("pre-fills the display name and about from the signed-in user", () => {
    setUser({ display_name: "Alice A.", about: "writes tests" });
    container.appendChild(buildAccountTab(makeOptions(), ac.signal));

    const name = container.querySelector<HTMLInputElement>('[data-testid="display-name-input"]')!;
    const about = container.querySelector<HTMLTextAreaElement>('[data-testid="about-input"]')!;
    expect(name.value).toBe("Alice A.");
    expect(about.value).toBe("writes tests");
  });

  it("heads the card with the display name, falling back to the username", () => {
    setUser({ display_name: "Alice A." });
    container.appendChild(buildAccountTab(makeOptions(), ac.signal));
    expect(container.querySelector(".account-header-name")?.textContent).toBe("Alice A.");
    // The letter fallback follows the rendered name, not the username.
    expect(container.querySelector('[data-testid="account-avatar"]')?.textContent).toBe("A");

    container.replaceChildren();
    setUser({ display_name: null });
    container.appendChild(buildAccountTab(makeOptions(), ac.signal));
    expect(container.querySelector(".account-header-name")?.textContent).toBe("alice");
  });

  it("sends both fields on save, empty string included", async () => {
    setUser({ display_name: "Alice A.", about: "writes tests" });
    const options = makeOptions();
    container.appendChild(buildAccountTab(options, ac.signal));

    const name = container.querySelector<HTMLInputElement>('[data-testid="display-name-input"]')!;
    const about = container.querySelector<HTMLTextAreaElement>('[data-testid="about-input"]')!;
    name.value = "  Ada  ";
    about.value = "";
    container.querySelector<HTMLButtonElement>('[data-testid="profile-save-btn"]')!.click();

    // "" is the API's "clear it"; omitting the field would mean "leave it
    // alone", so a blanked textarea has to be sent, not dropped.
    await vi.waitFor(() => {
      expect(options.onUpdateProfile).toHaveBeenCalledWith({ display_name: "Ada", about: "" });
    });
  });

  it("surfaces a save failure without clearing the form", async () => {
    setUser({});
    const options = makeOptions({
      onUpdateProfile: vi.fn().mockRejectedValue(new Error("display_name too long")),
    });
    container.appendChild(buildAccountTab(options, ac.signal));

    const name = container.querySelector<HTMLInputElement>('[data-testid="display-name-input"]')!;
    name.value = "Ada";
    container.querySelector<HTMLButtonElement>('[data-testid="profile-save-btn"]')!.click();

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="profile-error"]')?.textContent).toBe(
        "display_name too long",
      );
    });
    expect(name.value).toBe("Ada");
  });

  it("leaves focus where the user moved it while the save was in flight", async () => {
    const { settle, save } = openEditorWithHeldSave();
    const about = container.querySelector<HTMLTextAreaElement>('[data-testid="about-input"]')!;
    save.focus();
    save.click();
    about.focus();
    settle();

    await vi.waitFor(() => {
      expect(save.disabled).toBe(false);
    });
    expect(document.activeElement).toBe(about);
  });

  it("puts focus back on Save when it fell to the page during the save", async () => {
    const { settle, save } = openEditorWithHeldSave();
    save.focus();
    save.click();
    // What Chromium does to a focused control once it is disabled.
    save.blur();
    settle();

    await vi.waitFor(() => {
      expect(save.disabled).toBe(false);
    });
    expect(document.activeElement).toBe(save);
  });

  it("bounds the inputs at the server's caps", () => {
    setUser({});
    container.appendChild(buildAccountTab(makeOptions(), ac.signal));
    expect(
      container.querySelector('[data-testid="display-name-input"]')?.getAttribute("maxlength"),
    ).toBe("64"); // 2 UTF-16 units per character; the 32-character cap is enforced by count
    expect(container.querySelector('[data-testid="about-input"]')?.getAttribute("maxlength")).toBe(
      "300",
    );
  });

  it("offers an avatar uploader restricted to the accepted types", () => {
    setUser({});
    container.appendChild(buildAccountTab(makeOptions(), ac.signal));
    const input = container.querySelector<HTMLInputElement>('[data-testid="avatar-file-input"]')!;
    expect(input.getAttribute("accept")).toBe("image/png,image/jpeg,image/webp,image/gif");
    expect(container.querySelector('[data-testid="avatar-upload-btn"]')).not.toBeNull();
  });
});

describe("Remove avatar (3C-7a)", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("is hidden when the user has no avatar", () => {
    setUser({ avatar: null });
    const btn = build(makeOptions()).querySelector<HTMLButtonElement>(
      '[data-testid="avatar-remove-btn"]',
    )!;
    expect(btn.hidden).toBe(true);
  });

  it("is shown with an avatar and calls onRemoveAvatar", async () => {
    setUser({ avatar: "/api/v1/files/abc" });
    const onRemoveAvatar = vi.fn().mockResolvedValue(undefined);
    const container = build(makeOptions({ onRemoveAvatar }));
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="avatar-remove-btn"]')!;
    expect(btn.hidden).toBe(false);
    btn.click();
    await vi.waitFor(() => expect(onRemoveAvatar).toHaveBeenCalledTimes(1));
  });

  it("shows an error and keeps the button when removal fails", async () => {
    setUser({ avatar: "/api/v1/files/abc" });
    const onRemoveAvatar = vi.fn().mockRejectedValue(new Error("nope"));
    const container = build(makeOptions({ onRemoveAvatar }));
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="avatar-remove-btn"]')!;
    btn.click();
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="avatar-error"]')?.textContent).toBeTruthy(),
    );
    expect(btn.hidden).toBe(false);
    expect(btn.disabled).toBe(false);
  });
});

describe("Banner controls", () => {
  afterEach(() => {
    document.body.replaceChildren();
    resetServerCapabilities();
    cropSpy?.mockRestore();
    cropSpy = undefined;
  });
  let cropSpy: ReturnType<typeof vi.spyOn> | undefined;

  const q = (c: HTMLElement, id: string): HTMLButtonElement =>
    c.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
  const withBanners = (over?: Partial<SettingsOverlayOptions>): SettingsOverlayOptions =>
    makeOptions({
      onUploadBanner: vi.fn().mockResolvedValue("/api/v1/files/b1"),
      onRemoveBanner: vi.fn().mockResolvedValue(undefined),
      ...over,
    });

  it("banner controls hidden without capability", () => {
    setUser({ banner: "/api/v1/files/b1", banner_color: "#112233" });
    const container = build(withBanners());
    expect(container.querySelector('[data-testid="banner-editor"]')).toBeNull();
    expect(container.querySelector('[data-testid="banner-upload-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="banner-color-input"]')).toBeNull();
  });

  it("remove shown only with a banner", () => {
    applyReadyCapabilities({ profile_banners: true });
    setUser({ banner: null });
    const container = build(withBanners());
    expect(q(container, "banner-upload-btn").hidden).toBe(false);
    expect(q(container, "banner-remove-btn").hidden).toBe(true);
    // An upload (or another device) that sets a banner shows it.
    authStore.setState((prev) => ({
      ...prev,
      user: { ...prev.user!, banner: "/api/v1/files/b1" },
    }));
    return vi.waitFor(() => expect(q(container, "banner-remove-btn").hidden).toBe(false));
  });

  it("404 on upload shows the storage-off error", async () => {
    applyReadyCapabilities({ profile_banners: true });
    setUser({});
    cropSpy = vi.spyOn(imageCrop, "cropImage").mockResolvedValue({
      ok: true,
      file: new File(["b"], "banner.png", { type: "image/png" }),
    });
    const onUploadBanner = vi.fn().mockRejectedValue(new ApiClientError(404, "NOT_FOUND", "gone"));
    const container = build(withBanners({ onUploadBanner }));
    const input = q(container, "banner-file-input") as unknown as HTMLInputElement;
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "pic.png", { type: "image/png" })],
    });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="banner-error"]')?.textContent).toBe(
        "Banner uploads are turned off on this server.",
      ),
    );
    expect(onUploadBanner).toHaveBeenCalledTimes(1);
    expect(q(container, "banner-upload-btn").disabled).toBe(false);
  });

  it("saves an edited colour with Save Profile and sends nothing when unchanged", async () => {
    applyReadyCapabilities({ profile_banners: true });
    setUser({ banner_color: "#112233" });
    const onUpdateProfile = vi.fn().mockResolvedValue(undefined);
    const container = build(withBanners({ onUpdateProfile }));
    q(container, "profile-save-btn").click();
    await vi.waitFor(() => expect(onUpdateProfile).toHaveBeenCalledTimes(1));
    expect(onUpdateProfile.mock.calls[0]![0]).not.toHaveProperty("banner_color");
    await vi.waitFor(() => expect(q(container, "profile-save-btn").disabled).toBe(false));

    const colour = q(container, "banner-color-input") as unknown as HTMLInputElement;
    colour.value = "#ff0000";
    colour.dispatchEvent(new Event("input"));
    q(container, "profile-save-btn").click();
    await vi.waitFor(() => expect(onUpdateProfile).toHaveBeenCalledTimes(2));
    expect(onUpdateProfile.mock.calls[1]![0]).toMatchObject({ banner_color: "#ff0000" });
    await vi.waitFor(() => expect(q(container, "profile-save-btn").disabled).toBe(false));

    q(container, "banner-color-clear").click();
    await vi.waitFor(() => expect(q(container, "profile-save-btn").disabled).toBe(false));
    q(container, "profile-save-btn").click();
    await vi.waitFor(() => expect(onUpdateProfile).toHaveBeenCalledTimes(3));
    expect(onUpdateProfile.mock.calls[2]![0]).toMatchObject({ banner_color: "" });
  });
});

describe("prepareBannerFile", () => {
  afterEach(() => vi.restoreAllMocks());

  const animatedWebp = (): Uint8Array<ArrayBuffer> => {
    const head = new Uint8Array(30);
    head.set(
      [..."RIFF"].map((c) => c.charCodeAt(0)),
      0,
    );
    head.set(
      [..."WEBP"].map((c) => c.charCodeAt(0)),
      8,
    );
    head.set(
      [..."VP8X"].map((c) => c.charCodeAt(0)),
      12,
    );
    head[20] = 0x02;
    return head;
  };

  it("sends a GIF or an animated WebP uncropped, so it keeps its frames", async () => {
    const crop = vi.spyOn(imageCrop, "cropImage");
    const gif = new File(["GIF89a"], "b.gif", { type: "image/gif" });
    expect(await prepareBannerFile(gif)).toEqual({ ok: true, file: gif });
    const webp = new File([animatedWebp()], "b.webp", { type: "image/webp" });
    expect(await prepareBannerFile(webp)).toEqual({ ok: true, file: webp });
    expect(crop).not.toHaveBeenCalled();
  });

  it("refuses an animated banner over 4 MB", async () => {
    const big = new File([new Uint8Array(4 * 1024 * 1024 + 1)], "b.gif", { type: "image/gif" });
    expect(await prepareBannerFile(big)).toEqual({
      ok: false,
      error: "Banner must be at most 4096 KB.",
    });
  });

  it("crops a still picture to 5:2 as before", async () => {
    const cropped = new File(["c"], "banner.png", { type: "image/png" });
    const crop = vi.spyOn(imageCrop, "cropImage").mockResolvedValue({ ok: true, file: cropped });
    const still = new File([new Uint8Array(64)], "b.png", { type: "image/png" });
    expect(await prepareBannerFile(still)).toEqual({ ok: true, file: cropped });
    expect(crop).toHaveBeenCalledWith(still, { aspect: 2.5, maxWidth: 1200, fileBase: "banner" });
  });
});
