import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/settingsOverlayMocks";
import { createSettingsOverlay } from "../../../src/features/settings/SettingsOverlay";
import { buildMyUploadsTab } from "../../../src/features/uploads/myUploadsTab";
import { ApiClientError } from "../../../src/lib/api";
import {
  clickEl,
  defaultOptions,
  openOverlay,
  acButton,
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

  it("calls onChangePassword and clears inputs on success", async () => {
    const onChangePassword = vi.fn().mockResolvedValue(undefined);
    const overlay = openOverlay(container, { ...defaultOptions, onChangePassword });

    const inputs = fillPasswordForm(container, "oldpass123", "newpassword123", "newpassword123");

    const changePwBtn = acButton(container, "Change Password");
    changePwBtn.click();

    await vi.waitFor(() => {
      expect(onChangePassword).toHaveBeenCalledWith("oldpass123", "newpassword123");
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
      expect(onChangePassword).toHaveBeenCalledWith("oldpass123", "newpassword123");
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
