import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/settingsOverlayMocks";
import { createSettingsOverlay } from "../../../src/features/settings/SettingsOverlay";
import type { SettingsOverlayOptions } from "../../../src/features/settings/SettingsOverlay";
import { buildMyUploadsTab } from "../../../src/features/uploads/myUploadsTab";
import { ApiClientError } from "../../../src/lib/api";
import {
  clickEl,
  defaultOptions,
  openOverlay,
  acButton,
  getTab,
  testId,
  submitDeleteAccount,
  fillPasswordForm,
  useSettingsOverlayHarness,
} from "../../helpers/settingsOverlayHarness";

vi.mock("../../../src/features/whats-new/appVersion", () => mocks.newAppVersionMock());
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@stores/ui.store", () => mocks.uiStoreMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@stores/auth.store", () => mocks.authStoreMock());

const { mockAppVersion } = mocks;

describe("SettingsOverlay", () => {
  let container: HTMLDivElement;
  useSettingsOverlayHarness((el) => {
    container = el;
  });

  // --- Account tab tests ---

  it("shows current username", () => {
    const overlay = openOverlay(container);

    const acName = container.querySelector(".account-header-name");
    expect(acName?.textContent).toBe("testuser");

    overlay.destroy?.();
  });

  it("asks before logging out: one click only opens the prompt, confirming logs out", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    clickEl(container.querySelector(".settings-nav-item.danger"));
    expect(defaultOptions.onLogout).not.toHaveBeenCalled();
    const dialog = document.querySelector("[data-testid='logout-confirm-dialog']");
    expect(dialog?.textContent).toContain("Are you sure you want to log out?");

    clickEl(document.querySelector("[data-testid='logout-confirm']"));
    expect(defaultOptions.onLogout).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-testid='logout-confirm-dialog']")).toBeNull();

    overlay.destroy?.();
  });

  it("mounts the Log Out prompt inside the settings overlay so it stacks above it", () => {
    const overlay = openOverlay(container);

    clickEl(container.querySelector(".settings-nav-item.danger"));
    const dialog = document.querySelector("[data-testid='logout-confirm-dialog']");
    expect(dialog?.closest(".settings-overlay")).not.toBeNull();

    overlay.destroy?.();
  });

  it("Escape with the Log Out prompt open closes only the prompt", () => {
    const overlay = openOverlay(container);

    clickEl(container.querySelector(".settings-nav-item.danger"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector("[data-testid='logout-confirm-dialog']")).toBeNull();
    expect(defaultOptions.onClose).not.toHaveBeenCalled();
    expect(defaultOptions.onLogout).not.toHaveBeenCalled();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(defaultOptions.onClose).toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("Escape with the My uploads remove confirmation open cancels only it", async () => {
    const api = {
      getUserStorage: vi.fn().mockResolvedValue({ used_bytes: 1, quota_bytes: 0 }),
      listUserUploads: vi.fn().mockResolvedValue({
        items: [
          {
            attachment: {
              id: "a",
              filename: "a.pdf",
              size: 5,
              mime: "application/pdf",
              url: "/f/a",
            },
            uploaded_at: "2026-10-01 10:00:00",
            channel_id: null,
            message_id: null,
            state: "pending",
            removable: true,
          },
        ],
      }),
      removeUserUpload: vi.fn().mockResolvedValue(undefined),
    };
    const overlay = openOverlay(container, {
      ...defaultOptions,
      myUploadsTab: (signal) =>
        buildMyUploadsTab(signal, api, {
          formatFileSize: (n: number) => `${n} B`,
          isImage: (mime: string) => mime.startsWith("image/"),
          thumbnail: () => Promise.resolve(null),
        }),
    });
    const tab = [...container.querySelectorAll<HTMLElement>(".settings-nav-item")].find(
      (b) => b.textContent === "My uploads",
    )!;
    tab.click();
    await vi.waitFor(() => expect(container.querySelector(".my-uploads__remove")).not.toBeNull());
    container.querySelector<HTMLElement>(".my-uploads__remove")!.click();
    expect(document.querySelector("[data-testid='uploads-remove-confirm']")).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector("[data-testid='uploads-remove-confirm']")).toBeNull();
    expect(defaultOptions.onClose).not.toHaveBeenCalled();
    expect(container.querySelectorAll(".my-uploads__row")).toHaveLength(1);
    expect(api.removeUserUpload).not.toHaveBeenCalled();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(defaultOptions.onClose).toHaveBeenCalled();
    overlay.destroy?.();
  });

  it("cancelling the Log Out prompt does not log out", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    clickEl(container.querySelector(".settings-nav-item.danger"));
    clickEl(document.querySelector("[data-testid='logout-cancel']"));
    expect(defaultOptions.onLogout).not.toHaveBeenCalled();
    expect(document.querySelector("[data-testid='logout-confirm-dialog']")).toBeNull();

    overlay.destroy?.();
  });

  it("destroying the overlay with the Log Out prompt open removes it and does not log out", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    clickEl(container.querySelector(".settings-nav-item.danger"));
    expect(document.querySelector("[data-testid='logout-confirm-dialog']")).not.toBeNull();
    overlay.destroy?.();

    expect(document.querySelector("[data-testid='logout-confirm-dialog']")).toBeNull();
    expect(defaultOptions.onLogout).not.toHaveBeenCalled();
    // Nothing left to answer: a later Escape or click has no handler to run.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(defaultOptions.onLogout).not.toHaveBeenCalled();
  });

  it("shows the app version in small text under Log Out", async () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    await vi.waitFor(() => {
      expect(container.querySelector(".settings-sidebar-version")?.textContent).toBe(
        "Version 1.2.3-test",
      );
    });
    const sidebar = container.querySelector(".settings-sidebar")!;
    const logout = sidebar.querySelector(".settings-sidebar-logout")!;
    expect(logout.nextElementSibling?.className).toContain("settings-sidebar-version");
    overlay.destroy?.();
  });

  it("leaves the nav without a version when the host reports none", async () => {
    mockAppVersion.mockResolvedValueOnce(null);
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelector(".settings-sidebar-version")).toBeNull();
    overlay.destroy?.();
  });

  it("validates password change requires minimum length", () => {
    const overlay = openOverlay(container);

    fillPasswordForm(container, "oldpass123", "short", "short");

    const changePwBtn = acButton(container, "Change Password");
    changePwBtn.click();

    expect(defaultOptions.onChangePassword).not.toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("validates password confirmation matches", () => {
    const overlay = openOverlay(container);

    fillPasswordForm(container, "oldpass123", "newpassword123", "differentpassword");

    const changePwBtn = acButton(container, "Change Password");
    changePwBtn.click();

    expect(defaultOptions.onChangePassword).not.toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("requires the current password before calling the server", () => {
    const overlay = openOverlay(container);

    fillPasswordForm(container, "", "newpassword123", "newpassword123");

    const changePwBtn = acButton(container, "Change Password");
    changePwBtn.click();

    // An empty current password is a guaranteed 403 — and each one counts
    // against the server's lockout counter.
    expect(defaultOptions.onChangePassword).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter your current password.");

    overlay.destroy?.();
  });

  it("blocks a double submit while the password change is in flight", async () => {
    let resolveChange: (() => void) | null = null;
    const onChangePassword = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          resolveChange = () => resolve(undefined);
        }),
    );
    const overlay = openOverlay(container, { ...defaultOptions, onChangePassword });

    fillPasswordForm(container, "oldpass123", "newpassword123", "newpassword123");

    const changePwBtn = acButton(container, "Change Password");
    changePwBtn.click();
    expect(changePwBtn.disabled).toBe(true);
    expect(changePwBtn.textContent).toBe("Changing...");

    changePwBtn.click();
    expect(onChangePassword).toHaveBeenCalledTimes(1);

    resolveChange!();
    await vi.waitFor(() => {
      expect(changePwBtn.disabled).toBe(false);
      expect(changePwBtn.textContent).toBe("Change Password");
    });

    overlay.destroy?.();
  });

  const BOT_TOKEN = {
    id: 1,
    label: "bot",
    created_at: "2026-10-01 10:00:00",
    last_used: null,
    expires_at: null,
  };
  const revokeRow = (): HTMLElement =>
    container.querySelector<HTMLElement>('[data-testid="pw-revoke-api-tokens-row"]')!;
  const revokeBox = (): HTMLInputElement =>
    container.querySelector<HTMLInputElement>('[data-testid="pw-revoke-api-tokens"]')!;
  /** Open the overlay on an account whose token list is `onListApiTokens`. */
  function openWithTokens(onListApiTokens: SettingsOverlayOptions["onListApiTokens"]): {
    overlay: ReturnType<typeof openOverlay>;
    onChangePassword: ReturnType<typeof vi.fn>;
  } {
    const onChangePassword = vi.fn().mockResolvedValue(undefined);
    const overlay = openOverlay(container, {
      ...defaultOptions,
      onChangePassword,
      onListApiTokens,
      onRevokeApiToken: vi.fn().mockResolvedValue(undefined),
    });
    return { overlay, onChangePassword };
  }
  async function changePassword(from: string, to: string): Promise<void> {
    fillPasswordForm(container, from, to, to);
    acButton(container, "Change Password").click();
  }

  it("revokes API tokens with the password change while the option stays ticked", async () => {
    const { overlay, onChangePassword } = openWithTokens(vi.fn().mockResolvedValue([BOT_TOKEN]));
    await vi.waitFor(() => expect(revokeRow().hidden).toBe(false));
    expect(revokeBox().checked).toBe(true);

    await changePassword("oldpass123", "newpassword123");
    await vi.waitFor(() => {
      expect(onChangePassword).toHaveBeenCalledWith("oldpass123", "newpassword123", true);
    });
    overlay.destroy?.();
  });

  it("never re-ticks the option after the user unticked it, even when a refresh lands later", async () => {
    let releaseRefresh!: (tokens: (typeof BOT_TOKEN)[]) => void;
    const onListApiTokens = vi
      .fn()
      .mockResolvedValueOnce([BOT_TOKEN])
      .mockImplementation(
        () =>
          new Promise<(typeof BOT_TOKEN)[]>((resolve) => {
            releaseRefresh = resolve;
          }),
      );
    const { overlay, onChangePassword } = openWithTokens(onListApiTokens);
    await vi.waitFor(() => expect(revokeRow().hidden).toBe(false));

    // A ticked change asks for a refresh, which stays in flight.
    await changePassword("oldpass123", "newpassword123");
    await vi.waitFor(() => expect(onListApiTokens.mock.calls.length).toBeGreaterThan(1));

    revokeBox().checked = false;
    revokeBox().dispatchEvent(new Event("change"));
    releaseRefresh([BOT_TOKEN]);
    await vi.waitFor(() => expect(acButton(container, "Change Password").disabled).toBe(false));
    await Promise.resolve();
    expect(revokeBox().checked).toBe(false);

    await changePassword("newpassword123", "another-pass1");
    await vi.waitFor(() => {
      expect(onChangePassword).toHaveBeenLastCalledWith("newpassword123", "another-pass1", false);
    });
    overlay.destroy?.();
  });

  it("keeps the revoke default when the token list cannot be read", async () => {
    const { overlay } = openWithTokens(vi.fn().mockRejectedValue(new Error("network down")));
    await vi.waitFor(() => expect(revokeRow().hidden).toBe(false));
    expect(revokeBox().checked).toBe(true);
    overlay.destroy?.();
  });

  it("sends the revoke default when the form is submitted before the token list loads", async () => {
    const { overlay, onChangePassword } = openWithTokens(vi.fn(() => new Promise<never>(() => {})));
    await changePassword("oldpass123", "newpassword123");
    await vi.waitFor(() => {
      expect(onChangePassword).toHaveBeenCalledWith("oldpass123", "newpassword123", true);
    });
    overlay.destroy?.();
  });

  it("calls onChangePassword and clears inputs on success", async () => {
    const onChangePassword = vi.fn().mockResolvedValue(undefined);
    const overlay = openOverlay(container, { ...defaultOptions, onChangePassword });

    const inputs = fillPasswordForm(container, "oldpass123", "newpassword123", "newpassword123");

    const changePwBtn = acButton(container, "Change Password");
    changePwBtn.click();

    await vi.waitFor(() => {
      expect(onChangePassword).toHaveBeenCalledWith("oldpass123", "newpassword123", false);
    });

    // Inputs should be cleared after success
    await vi.waitFor(() => {
      expect((inputs[0] as HTMLInputElement).value).toBe("");
      expect((inputs[1] as HTMLInputElement).value).toBe("");
      expect((inputs[2] as HTMLInputElement).value).toBe("");
    });

    overlay.destroy?.();
  });

  it("keeps a partial-success warning in the form instead of the green success", async () => {
    // The server answers 200 + warning when the password changed but the
    // other sessions could not be revoked; the form must carry that
    // instruction, not clear the fields under an unqualified green
    // "changed successfully" beside the warning toast.
    const warning =
      "password changed, but other sessions could not be revoked; revoke them from the sessions list";
    const onChangePassword = vi.fn().mockResolvedValue({ warning, sessions_revoked: 0 });
    const overlay = openOverlay(container, { ...defaultOptions, onChangePassword });

    const inputs = fillPasswordForm(container, "oldpass123", "newpassword123", "newpassword123");
    const changePwBtn = acButton(container, "Change Password");
    changePwBtn.click();

    const status = container.querySelector<HTMLElement>('[data-testid="pw-change-status"]');
    expect(status).not.toBeNull();
    await vi.waitFor(() => {
      expect(onChangePassword).toHaveBeenCalledWith("oldpass123", "newpassword123", false);
      expect(status!.textContent).toBe(warning);
    });
    // B9-23: the warning is the qualified .form-warning class, not an inline
    // --yellow (which reads 1.89:1 on light), and keeps the live role it was
    // created with so the swap to the warning text is announced.
    expect(status!.classList.contains("form-warning")).toBe(true);
    expect(status!.getAttribute("role")).toBe("alert");
    // The password did change, so the fields are cleared like any success.
    expect((inputs[0] as HTMLInputElement).value).toBe("");
    expect((inputs[1] as HTMLInputElement).value).toBe("");
    expect(container.textContent).not.toContain("Password changed successfully.");

    overlay.destroy?.();
  });

  it("shows error when password change fails", async () => {
    const onChangePassword = vi.fn().mockRejectedValue(new Error("Incorrect old password"));
    const overlay = openOverlay(container, { ...defaultOptions, onChangePassword });

    fillPasswordForm(container, "wrongold", "newpassword123", "newpassword123");

    const changePwBtn = acButton(container, "Change Password");
    changePwBtn.click();

    await vi.waitFor(() => {
      // B9-23: the error is the shared .form-error class with role=alert.
      const pwError = container.querySelector('[data-testid="pw-change-status"]');
      expect(pwError?.textContent).toBe("Incorrect old password");
      expect(pwError?.classList.contains("form-error")).toBe(true);
      expect(pwError?.getAttribute("role")).toBe("alert");
    });

    overlay.destroy?.();
  });

  it("shows error when username update fails", async () => {
    const onUpdateProfile = vi.fn().mockRejectedValue(new Error("Username taken"));
    const overlay = openOverlay(container, { ...defaultOptions, onUpdateProfile });

    const editBtn = container.querySelector(".account-field-edit") as HTMLElement;
    editBtn.click();

    const editInput = container.querySelector(
      '[data-testid="username-edit-input"]',
    ) as HTMLInputElement;
    editInput.value = "taken-name";

    const saveBtn = acButton(container, "Save");
    saveBtn.click();

    await vi.waitFor(() => {
      const nameError = container.querySelector<HTMLElement>("#username-edit-error");
      expect(nameError?.textContent).toBe("Username taken");
      expect(nameError?.getAttribute("role")).toBe("alert");
    });

    overlay.destroy?.();
  });

  // WP 3C-9: the rename and display-name inputs carry the new limits.
  function openUsernameEditor(onUpdateProfile = defaultOptions.onUpdateProfile) {
    const overlay = openOverlay(container, { ...defaultOptions, onUpdateProfile });
    (container.querySelector(".account-field-edit") as HTMLElement).click();
    const editInput = container.querySelector<HTMLInputElement>(
      '[data-testid="username-edit-input"]',
    )!;
    const saveBtn = acButton(container, "Save");
    const error = container.querySelector<HTMLElement>("#username-edit-error")!;
    return { overlay, editInput, saveBtn, error };
  }

  it("bounds the rename input and shows the rule", () => {
    const { overlay, editInput } = openUsernameEditor();
    expect(editInput.maxLength).toBe(64); // 2 units per character; the 32-character cap is by count
    const hintId = editInput.getAttribute("aria-describedby")!.split(" ").at(-1)!;
    const hint = container.querySelector<HTMLElement>(`#${hintId}`)!;
    expect(hint.textContent).toContain("2–32 characters");
    overlay.destroy?.();
  });

  it("fits and sends a 32-letter rename outside the BMP", async () => {
    const onUpdateProfile = vi.fn().mockResolvedValue(undefined);
    const { overlay, editInput, saveBtn } = openUsernameEditor(onUpdateProfile);
    const bold = "\u{1D400}".repeat(32); // 2 UTF-16 units per letter
    expect(bold.length).toBeLessThanOrEqual(editInput.maxLength);
    editInput.value = bold;
    saveBtn.click();
    await vi.waitFor(() => expect(onUpdateProfile).toHaveBeenCalledWith({ username: bold }));
    overlay.destroy?.();
  });

  it("does not send a rename the server's rules refuse (over the limit, reserved, bad character)", () => {
    const onUpdateProfile = vi.fn().mockResolvedValue(undefined);
    const { overlay, editInput, saveBtn, error } = openUsernameEditor(onUpdateProfile);
    for (const [typed, message] of [
      ["x".repeat(40), "Username must be 2–32 characters."],
      ["Here", "Username is reserved."],
      ["has space", "Username may only contain letters, digits, '_', '.' and '-'."],
    ] as const) {
      editInput.value = typed;
      saveBtn.click();
      expect(error.textContent).toBe(message);
      expect(editInput.value).toBe(typed);
    }
    expect(onUpdateProfile).not.toHaveBeenCalled();
    overlay.destroy?.();
  });

  it("shows the server's refusal of a rename inline and keeps the typed name", async () => {
    const onUpdateProfile = vi
      .fn()
      .mockRejectedValue(new ApiClientError(400, "INVALID_INPUT", "username is reserved"));
    const { overlay, editInput, saveBtn, error } = openUsernameEditor(onUpdateProfile);
    editInput.value = "passes-client";
    saveBtn.click();
    await vi.waitFor(() => expect(error.textContent).toBe("Username is reserved"));
    expect(editInput.value).toBe("passes-client");
    expect(editInput.getAttribute("aria-invalid")).toBe("true");
    overlay.destroy?.();
  });

  it("bounds the display name and does not send one over the limit", async () => {
    const onUpdateProfile = vi.fn().mockResolvedValue(undefined);
    const overlay = openOverlay(container, { ...defaultOptions, onUpdateProfile });
    const nameInput = container.querySelector<HTMLInputElement>(
      '[data-testid="display-name-input"]',
    )!;
    expect(nameInput.maxLength).toBe(64); // 2 units per character; the 32-character cap is by count
    const hint = nameInput.nextElementSibling as HTMLElement;
    expect(hint.textContent).toBe("Up to 32 characters, on one line.");

    const over = "n".repeat(50);
    nameInput.value = over;
    container.querySelector<HTMLElement>('[data-testid="profile-save-btn"]')!.click();
    expect(onUpdateProfile).not.toHaveBeenCalled();
    expect(hint.textContent).toBe("Display name must be at most 32 characters.");
    expect(container.querySelector('[data-testid="profile-error"]')?.textContent).toBe(
      "Check the highlighted field.",
    );
    expect(nameInput.value).toBe(over);
    overlay.destroy?.();
  });

  it("sends the display name with runs of spaces collapsed, as the server stores it", async () => {
    const onUpdateProfile = vi.fn().mockResolvedValue(undefined);
    const overlay = openOverlay(container, { ...defaultOptions, onUpdateProfile });
    container.querySelector<HTMLInputElement>('[data-testid="display-name-input"]')!.value =
      "  Ada    Lovelace ";
    container.querySelector<HTMLElement>('[data-testid="profile-save-btn"]')!.click();
    await vi.waitFor(() => expect(onUpdateProfile).toHaveBeenCalled());
    expect(onUpdateProfile.mock.calls[0]![0].display_name).toBe("Ada Lovelace");
    overlay.destroy?.();
  });

  it("shows the server's display-name refusal under the field and keeps the typed name", async () => {
    const onUpdateProfile = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError(
          400,
          "INVALID_INPUT",
          "display_name must not contain control characters or line breaks",
        ),
      );
    const overlay = openOverlay(container, { ...defaultOptions, onUpdateProfile });
    const nameInput = container.querySelector<HTMLInputElement>(
      '[data-testid="display-name-input"]',
    )!;
    const hint = nameInput.nextElementSibling as HTMLElement;
    nameInput.value = "Ada";
    container.querySelector<HTMLElement>('[data-testid="profile-save-btn"]')!.click();
    await vi.waitFor(() =>
      expect(hint.textContent).toBe(
        "Display_name must not contain control characters or line breaks",
      ),
    );
    // Said once, under the field; the status line points at it.
    expect(container.querySelector('[data-testid="profile-error"]')?.textContent).toBe(
      "Check the highlighted field.",
    );
    expect(nameInput.value).toBe("Ada");
    overlay.destroy?.();
  });

  it("Cancel button hides the username edit form", () => {
    const overlay = openOverlay(container);

    // Open edit form
    const editBtn = container.querySelector(".account-field-edit") as HTMLElement;
    editBtn.click();

    // Click cancel
    const cancelBtn = acButton(container, "Cancel");
    cancelBtn.click();

    // Edit form should be hidden
    const editInput = container.querySelector(
      '[data-testid="username-edit-input"]',
    ) as HTMLInputElement;
    const editForm = editInput.closest(".setting-row") as HTMLElement;
    expect(editForm.style.display).toBe("none");

    overlay.destroy?.();
  });

  // --- Delete account tests ---

  it("shows confirmation area when Delete Account is clicked", () => {
    const overlay = openOverlay(container);

    const triggerBtn = testId<HTMLElement>(container, "delete-account-trigger");
    expect(triggerBtn).not.toBeNull();

    const confirmArea = testId<HTMLElement>(container, "delete-account-confirm-area");
    expect(confirmArea.style.display).toBe("none");

    triggerBtn.click();

    expect(confirmArea.style.display).toBe("block");
    expect(triggerBtn.style.display).toBe("none");

    overlay.destroy?.();
  });

  it("hides confirmation area when Cancel is clicked", () => {
    const overlay = openOverlay(container);

    const triggerBtn = testId<HTMLElement>(container, "delete-account-trigger");
    triggerBtn.click();

    const confirmArea = testId<HTMLElement>(container, "delete-account-confirm-area");
    expect(confirmArea.style.display).toBe("block");

    const cancelBtn = confirmArea.querySelector("button:not(.account-delete-btn)") as HTMLElement;
    cancelBtn.click();

    expect(confirmArea.style.display).toBe("none");
    expect(triggerBtn.style.display).toBe("");

    overlay.destroy?.();
  });

  // B7-15c owner decision: the dialog states immediacy, backups and cached
  // images, and never a retention window — erasure hard-deletes at once.
  it("delete warning discloses immediacy, backups and cached images, and no retention window", () => {
    const overlay = openOverlay(container, {
      ...defaultOptions,
      getRetentionNotice: () => "By default this server deletes messages after 30 days.",
    });
    testId<HTMLElement>(container, "delete-account-trigger").click();

    const warning = container.querySelector(
      "[data-testid='delete-account-confirm-area']",
    )!.textContent!;
    expect(warning).toContain("immediate and permanent");
    expect(warning).toContain("backups made before you delete keep a copy until they rotate out");
    expect(warning).toContain("your deletion is applied again");
    expect(warning).toContain("cached on other people's devices");
    expect(warning).not.toMatch(/\bdays?\b/);
    expect(warning).not.toContain("By default this server");

    overlay.destroy?.();
  });

  it("shows the retention window in its own Account section when the server reported one", () => {
    const notice = "By default this server deletes messages after 30 days.";
    const overlay = openOverlay(container, { ...defaultOptions, getRetentionNotice: () => notice });

    const section = container.querySelector("[data-testid='account-retention']")!;
    expect(section.textContent).toContain(notice);
    expect(
      section.contains(container.querySelector("[data-testid='delete-account-confirm-area']")),
    ).toBe(false);

    overlay.destroy?.();
  });

  it("omits the retention section when the server did not report one", () => {
    const overlay = createSettingsOverlay({ ...defaultOptions, getRetentionNotice: () => null });
    overlay.mount(container);
    expect(container.querySelector("[data-testid='account-retention']")).toBeNull();
    overlay.destroy?.();
  });

  it("shows error when confirming delete without password", () => {
    const overlay = openOverlay(container);

    const triggerBtn = testId<HTMLElement>(container, "delete-account-trigger");
    triggerBtn.click();

    const confirmBtn = testId<HTMLElement>(container, "delete-account-confirm");
    confirmBtn.click();

    const errorEl = testId<HTMLElement>(container, "delete-account-error");
    expect(errorEl.textContent).toBe("Password is required.");
    expect(defaultOptions.onDeleteAccount).not.toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("calls onDeleteAccount with password on confirm", () => {
    const overlay = openOverlay(container);

    submitDeleteAccount(container, "mypassword123");

    expect(defaultOptions.onDeleteAccount).toHaveBeenCalledWith("mypassword123");

    overlay.destroy?.();
  });

  it("disables confirm button and shows 'Deleting...' during delete", () => {
    const overlay = openOverlay(container);

    const confirmBtn = submitDeleteAccount(container, "mypassword123");

    expect(confirmBtn.disabled).toBe(true);
    expect(confirmBtn.textContent).toBe("Deleting...");

    overlay.destroy?.();
  });

  it("shows error and re-enables button on delete failure", async () => {
    const failOptions = {
      ...defaultOptions,
      onDeleteAccount: vi.fn().mockRejectedValue(new Error("Wrong password")),
    };

    const overlay = openOverlay(container, failOptions);

    const confirmBtn = submitDeleteAccount(container, "wrongpassword");

    // Wait for the rejected promise to settle
    await vi.waitFor(() => {
      expect(confirmBtn.disabled).toBe(false);
    });

    const errorEl = testId<HTMLElement>(container, "delete-account-error");
    expect(errorEl.textContent).toBe("Wrong password");
    expect(confirmBtn.textContent).toBe("Confirm Delete");

    overlay.destroy?.();
  });

  it("clears password input when reopening confirmation area", () => {
    const overlay = openOverlay(container);

    const triggerBtn = testId<HTMLElement>(container, "delete-account-trigger");
    triggerBtn.click();

    const passwordInput = testId<HTMLInputElement>(container, "delete-account-password");
    passwordInput.value = "typed-something";

    // Cancel and reopen
    const confirmArea = testId<HTMLElement>(container, "delete-account-confirm-area");
    const cancelBtn = confirmArea.querySelector("button:not(.account-delete-btn)") as HTMLElement;
    cancelBtn.click();
    triggerBtn.click();

    expect(passwordInput.value).toBe("");

    overlay.destroy?.();
  });
});

const prompt = (): HTMLElement | null => testId(document, "unsaved-confirm-dialog");
const activeTabLabel = (container: ParentNode): string | null =>
  container.querySelector(".settings-nav-item.active")?.textContent ?? null;

describe("SettingsOverlay unsaved profile edits", () => {
  let container: HTMLDivElement;
  useSettingsOverlayHarness((el) => {
    container = el;
  });

  function typeAbout(text: string): void {
    const about = testId<HTMLTextAreaElement>(container, "about-input");
    about.value = text;
    about.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function expectEscapeClosesWithoutPrompt(overlay: { destroy?: () => void }): void {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(prompt()).toBeNull();
    expect(defaultOptions.onClose).toHaveBeenCalledTimes(1);
    overlay.destroy?.();
  }

  it("closes without asking when nothing was changed", () => {
    expectEscapeClosesWithoutPrompt(openOverlay(container));
  });

  it("asks before Escape throws away a typed about text; Keep editing keeps it", () => {
    const overlay = openOverlay(container);
    typeAbout("Hello there");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(prompt()).not.toBeNull();
    expect(defaultOptions.onClose).not.toHaveBeenCalled();

    testId(document, "unsaved-keep").click();
    expect(prompt()).toBeNull();
    expect(defaultOptions.onClose).not.toHaveBeenCalled();
    expect(testId<HTMLTextAreaElement>(container, "about-input").value).toBe("Hello there");
    overlay.destroy?.();
  });

  it("Discard lets the close go ahead", () => {
    const overlay = openOverlay(container);
    typeAbout("Hello there");
    container.querySelector<HTMLElement>(".settings-overlay")!.click();
    expect(prompt()).not.toBeNull();

    testId(document, "unsaved-discard").click();
    expect(defaultOptions.onClose).toHaveBeenCalledTimes(1);
    overlay.destroy?.();
  });

  it("asks before a tab switch and switches only on Discard", () => {
    const overlay = openOverlay(container);
    testId<HTMLInputElement>(container, "display-name-input").value = "New name";
    const other = getTab(container, 2);
    const otherLabel = other.textContent;

    other.click();
    expect(prompt()).not.toBeNull();
    expect(activeTabLabel(container)).toBe("Account");

    testId(document, "unsaved-discard").click();
    expect(activeTabLabel(container)).toBe(otherLabel);
    expect(testId(container, "display-name-input")).toBeNull();
    overlay.destroy?.();
  });

  it("a saved edit no longer counts as unsaved", async () => {
    const onUpdateProfile = vi.fn().mockImplementation((patch: { about?: string }) => {
      mocks.mockAuthState.user = { ...mocks.mockAuthState.user, ...patch };
      return Promise.resolve(undefined);
    });
    const overlay = openOverlay(container, { ...defaultOptions, onUpdateProfile });
    typeAbout("Saved text");
    testId(container, "profile-save-btn").click();
    await vi.waitFor(() => expect(onUpdateProfile).toHaveBeenCalledTimes(1));
    expectEscapeClosesWithoutPrompt(overlay);
  });

  it("counts a typed new username in the open rename field", () => {
    const overlay = openOverlay(container);
    (container.querySelector(".account-field-edit") as HTMLElement).click();
    testId<HTMLInputElement>(container, "username-edit-input").value = "someone-else";

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(prompt()).not.toBeNull();
    overlay.destroy?.();
    expect(prompt()).toBeNull();
  });
});

describe("SettingsOverlay username rename", () => {
  let container: HTMLDivElement;
  useSettingsOverlayHarness((el) => {
    container = el;
  });

  function openRename(onUpdateProfile: SettingsOverlayOptions["onUpdateProfile"]) {
    const overlay = openOverlay(container, { ...defaultOptions, onUpdateProfile });
    (container.querySelector(".account-field-edit") as HTMLElement).click();
    const input = testId<HTMLInputElement>(container, "username-edit-input");
    input.value = "new-name";
    return { overlay, input, save: acButton(container, "Save") };
  }

  it("Enter in the field saves", async () => {
    const onUpdateProfile = vi.fn().mockResolvedValue(undefined);
    const { overlay, input } = openRename(onUpdateProfile);
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(onUpdateProfile).toHaveBeenCalledWith({ username: "new-name" });
    overlay.destroy?.();
  });

  it("sends one request while one is in flight, then re-enables Save", async () => {
    let finish: () => void = () => {};
    const onUpdateProfile = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { overlay, input, save } = openRename(onUpdateProfile);
    save.click();
    expect(save.disabled).toBe(true);
    save.click();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onUpdateProfile).toHaveBeenCalledTimes(1);

    finish();
    await vi.waitFor(() => expect(save.disabled).toBe(false));
    overlay.destroy?.();
  });
});

const escape = (): void => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
};

describe("SettingsOverlay close guard beyond the profile fields", () => {
  let container: HTMLDivElement;
  useSettingsOverlayHarness((el) => {
    container = el;
  });

  async function showRecoveryKitSecret(): Promise<void> {
    testId(container, "recovery-kit-btn").click();
    testId<HTMLInputElement>(container, "recovery-kit-password").value = "hunter2hunter2";
    testId(container, "recovery-kit-submit").click();
    await vi.waitFor(() => expect(testId(container, "recovery-kit-secret")).not.toBeNull());
  }

  const kitOptions = {
    ...defaultOptions,
    onEnrolRecoveryKit: vi.fn().mockResolvedValue({ kit_secret: "KIT-SECRET", created_at: "x" }),
  };

  it("asks before Escape wipes a recovery secret that is on screen", async () => {
    const overlay = openOverlay(container, kitOptions);
    await showRecoveryKitSecret();

    escape();
    expect(prompt()?.textContent).toContain("shown only once");
    expect(defaultOptions.onClose).not.toHaveBeenCalled();

    testId(document, "unsaved-keep").click();
    expect(testId(container, "recovery-kit-secret")?.textContent).toBe("KIT-SECRET");
    overlay.destroy?.();
  });

  it("closes without asking once the secret was dismissed with Done", async () => {
    const overlay = openOverlay(container, kitOptions);
    await showRecoveryKitSecret();
    testId(container, "shown-once-done").click();

    escape();
    expect(prompt()).toBeNull();
    expect(defaultOptions.onClose).toHaveBeenCalledTimes(1);
    overlay.destroy?.();
  });

  it("asks before a tab switch drops a half-written custom theme", () => {
    const overlay = openOverlay(container);
    getTab(container, 1).click();
    const newTheme = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "New theme",
    )!;
    newTheme.click();
    testId<HTMLTextAreaElement>(container, "custom-theme-css").value = "body { color: red; }";

    escape();
    expect(prompt()?.textContent).toContain("custom theme");
    expect(defaultOptions.onClose).not.toHaveBeenCalled();

    testId(document, "unsaved-discard").click();
    expect(defaultOptions.onClose).toHaveBeenCalledTimes(1);
    overlay.destroy?.();
  });

  it("closes without asking while the theme editor is open but untouched", () => {
    const overlay = openOverlay(container);
    getTab(container, 1).click();
    Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent === "New theme")!
      .click();

    escape();
    expect(prompt()).toBeNull();
    expect(defaultOptions.onClose).toHaveBeenCalledTimes(1);
    overlay.destroy?.();
  });
});
