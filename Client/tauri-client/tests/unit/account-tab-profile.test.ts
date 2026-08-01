import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildAccountTab, validateAvatarFile } from "@components/settings/AccountTab";
import { authStore } from "@stores/auth.store";
import type { SettingsOverlayOptions } from "@components/SettingsOverlay";

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
  return {
    onClose: vi.fn(),
    onChangePassword: vi.fn().mockResolvedValue(undefined),
    onUpdateProfile: vi.fn().mockResolvedValue(undefined),
    onUploadAvatar: vi.fn().mockResolvedValue("/api/v1/files/abc"),
    onLogout: vi.fn(),
    onDeleteAccount: vi.fn().mockResolvedValue(undefined),
    onStatusChange: vi.fn(),
    onEnableTotp: vi.fn().mockResolvedValue({ qr_uri: "", backup_codes: [] }),
    onConfirmTotp: vi.fn().mockResolvedValue(undefined),
    onDisableTotp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("validateAvatarFile", () => {
  const ok = { width: 512, height: 512 };

  it("accepts a PNG, JPEG or WebP within the caps", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      expect(validateAvatarFile({ size: 1000, type }, ok)).toBeNull();
    }
  });

  it("rejects a type the server refuses", () => {
    // GIF is a real image and still refused — an animated avatar in every
    // message row is a distraction the renderer cannot opt out of.
    expect(validateAvatarFile({ size: 1000, type: "image/gif" }, ok)).toMatch(/PNG, JPEG or WebP/);
    expect(validateAvatarFile({ size: 1000, type: "image/svg+xml" }, ok)).not.toBeNull();
  });

  it("rejects a file over 1 MB", () => {
    expect(validateAvatarFile({ size: 1024 * 1024 + 1, type: "image/png" }, ok)).toMatch(/KB/);
    // Exactly at the cap is fine.
    expect(validateAvatarFile({ size: 1024 * 1024, type: "image/png" }, ok)).toBeNull();
  });

  it("rejects an image bigger than any surface renders", () => {
    expect(
      validateAvatarFile({ size: 1000, type: "image/png" }, { width: 2000, height: 100 }),
    ).toMatch(/pixels/);
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

  it("bounds the inputs at the server's caps", () => {
    setUser({});
    container.appendChild(buildAccountTab(makeOptions(), ac.signal));
    expect(
      container.querySelector('[data-testid="display-name-input"]')?.getAttribute("maxlength"),
    ).toBe("32");
    expect(container.querySelector('[data-testid="about-input"]')?.getAttribute("maxlength")).toBe(
      "300",
    );
  });

  it("offers an avatar uploader restricted to the accepted types", () => {
    setUser({});
    container.appendChild(buildAccountTab(makeOptions(), ac.signal));
    const input = container.querySelector<HTMLInputElement>('[data-testid="avatar-file-input"]')!;
    expect(input.getAttribute("accept")).toBe("image/png,image/jpeg,image/webp");
    expect(container.querySelector('[data-testid="avatar-upload-btn"]')).not.toBeNull();
  });
});
