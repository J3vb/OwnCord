/**
 * Account settings tab — profile editing, password change.
 * Discord-style profile card with colored banner, overlapping avatar,
 * and separated field rows.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import type { UserStatus } from "@lib/types";
import { authStore } from "@stores/auth.store";
import type { SettingsOverlayOptions } from "../SettingsOverlay";
import { loadPref, savePref } from "./helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProfileCardResult {
  readonly card: HTMLDivElement;
  readonly headerName: HTMLDivElement;
  readonly usernameValue: HTMLDivElement;
  readonly editUserProfileBtn: HTMLButtonElement;
  readonly editUsernameBtn: HTMLButtonElement;
}

// ---------------------------------------------------------------------------
// Profile card builder
// ---------------------------------------------------------------------------

function buildProfileCard(username: string): ProfileCardResult {
  const card = createElement("div", { class: "account-card" });
  const banner = createElement("div", { class: "account-banner" });

  // Avatar overlapping the banner
  const avatarWrap = createElement("div", { class: "account-avatar-wrap" });
  const avatarLarge = createElement("div", { class: "account-avatar-large" },
    username.charAt(0).toUpperCase(),
  );
  const statusDot = createElement("div", { class: "account-status-dot" });
  appendChildren(avatarWrap, avatarLarge, statusDot);

  // Header row
  const accountHeader = createElement("div", { class: "account-header" });
  const headerName = createElement("div", { class: "account-header-name" }, username);
  const editUserProfileBtn = createElement("button", { class: "ac-btn" }, "Edit User Profile");
  appendChildren(accountHeader, headerName, editUserProfileBtn);

  // Username field row
  const fieldsContainer = createElement("div", { class: "account-fields" });
  const usernameField = createElement("div", { class: "account-field" });
  const usernameLeft = createElement("div", {});
  const usernameLabel = createElement("div", { class: "account-field-label" }, "Username");
  const usernameValue = createElement("div", { class: "account-field-value" }, username);
  appendChildren(usernameLeft, usernameLabel, usernameValue);
  const editUsernameBtn = createElement("button", { class: "account-field-edit" }, "Edit");
  appendChildren(usernameField, usernameLeft, editUsernameBtn);
  fieldsContainer.appendChild(usernameField);

  appendChildren(card, banner, avatarWrap, accountHeader, fieldsContainer);

  return { card, headerName, usernameValue, editUserProfileBtn, editUsernameBtn };
}

// ---------------------------------------------------------------------------
// Password section builder
// ---------------------------------------------------------------------------

function buildPasswordSection(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const wrapper = createElement("div", {});

  const separator = createElement("div", { class: "settings-separator" });
  const pwHeader = createElement("div", { class: "settings-section-title" }, "Password and Authentication");

  const oldPw = createElement("input", {
    class: "form-input", type: "password",
    placeholder: "Old password", style: "margin-bottom:12px",
  });
  const newPw = createElement("input", {
    class: "form-input", type: "password",
    placeholder: "New password", style: "margin-bottom:12px",
  });
  const confirmPw = createElement("input", {
    class: "form-input", type: "password",
    placeholder: "Confirm new password", style: "margin-bottom:12px",
  });
  const pwError = createElement("div", { style: "color:var(--red);font-size:13px;margin-bottom:8px" });
  const pwBtn = createElement("button", { class: "ac-btn" }, "Change Password");
  let pwSuccessTimer: ReturnType<typeof setTimeout> | null = null;

  pwBtn.addEventListener("click", () => {
    const oldVal = oldPw.value;
    const newVal = newPw.value;
    const confirmVal = confirmPw.value;

    if (newVal.length < 8) {
      setText(pwError, "New password must be at least 8 characters.");
      return;
    }
    if (newVal !== confirmVal) {
      setText(pwError, "Passwords do not match.");
      return;
    }
    setText(pwError, "");
    void options.onChangePassword(oldVal, newVal).then(() => {
      oldPw.value = "";
      newPw.value = "";
      confirmPw.value = "";
      if (pwSuccessTimer !== null) clearTimeout(pwSuccessTimer);
      pwError.style.color = "var(--green)";
      setText(pwError, "Password changed successfully.");
      pwSuccessTimer = setTimeout(() => {
        setText(pwError, "");
        pwError.style.color = "var(--red)";
        pwSuccessTimer = null;
      }, 3000);
    }).catch((err: unknown) => {
      setText(pwError, err instanceof Error ? err.message : "Failed to change password.");
    });
  }, { signal });

  appendChildren(wrapper, separator, pwHeader, oldPw, newPw, confirmPw, pwError, pwBtn);
  return wrapper;
}

// ---------------------------------------------------------------------------
// TOTP section builder
// ---------------------------------------------------------------------------

function buildTotpEnrollForm(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
  onEnrolled: () => void,
): HTMLDivElement {
  const wrapper = createElement("div", {});

  const description = createElement("div", {
    style: "color:var(--text-muted);font-size:13px;margin-bottom:12px",
  }, "Add an extra layer of security to your account.");

  const enableBtn = createElement("button", {
    class: "ac-btn",
    "data-testid": "totp-enable-btn",
  }, "Enable 2FA");

  const formArea = createElement("div", { style: "display:none" });
  const pwInput = createElement("input", {
    class: "form-input", type: "password",
    placeholder: "Enter your password", style: "margin-bottom:12px",
    "data-testid": "totp-password-input",
  });
  const errorEl = createElement("div", {
    style: "color:var(--red);font-size:13px;margin-bottom:8px",
    "data-testid": "totp-error",
  });
  const submitBtn = createElement("button", { class: "ac-btn" }, "Submit");

  appendChildren(formArea, pwInput, errorEl, submitBtn);

  const enrollArea = createElement("div", { style: "display:none" });

  enableBtn.addEventListener("click", () => {
    enableBtn.style.display = "none";
    formArea.style.display = "block";
    pwInput.value = "";
    setText(errorEl, "");
    pwInput.focus();
  }, { signal });

  submitBtn.addEventListener("click", () => {
    const pw = pwInput.value;
    if (pw.length === 0) {
      setText(errorEl, "Password is required.");
      return;
    }
    setText(errorEl, "");
    submitBtn.disabled = true;
    setText(submitBtn, "Requesting...");

    void options.onEnableTotp(pw).then((result) => {
      formArea.style.display = "none";
      buildTotpConfirmArea(enrollArea, options, pw, result, signal, onEnrolled);
      enrollArea.style.display = "block";
      submitBtn.disabled = false;
      setText(submitBtn, "Submit");
    }).catch((err: unknown) => {
      setText(errorEl, err instanceof Error ? err.message : "Failed to enable 2FA.");
      submitBtn.disabled = false;
      setText(submitBtn, "Submit");
    });
  }, { signal });

  appendChildren(wrapper, description, enableBtn, formArea, enrollArea);
  return wrapper;
}

function buildTotpConfirmArea(
  container: HTMLDivElement,
  options: SettingsOverlayOptions,
  password: string,
  result: { qr_uri: string; backup_codes: string[] },
  signal: AbortSignal,
  onEnrolled: () => void,
): void {
  // Clear previous content immutably (remove children)
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }

  const qrLabel = createElement("div", {
    style: "color:var(--text-muted);font-size:13px;margin-bottom:8px",
  }, "Scan this URI with your authenticator app, or copy it manually:");

  const qrUri = createElement("code", {
    style: "display:block;background:var(--bg-active);padding:8px 12px;border-radius:6px;" +
      "font-family:monospace;font-size:12px;word-break:break-all;margin-bottom:12px;" +
      "color:var(--text-primary);user-select:all",
    "data-testid": "totp-qr-uri",
  }, result.qr_uri);

  const elements: HTMLElement[] = [qrLabel, qrUri];

  if (result.backup_codes.length > 0) {
    const backupLabel = createElement("div", {
      style: "color:var(--text-muted);font-size:13px;margin-bottom:8px",
    }, "Save these backup codes in a safe place:");
    const backupList = createElement("code", {
      style: "display:block;background:var(--bg-active);padding:8px 12px;border-radius:6px;" +
        "font-family:monospace;font-size:12px;white-space:pre-wrap;margin-bottom:12px;" +
        "color:var(--text-primary);user-select:all",
    }, result.backup_codes.join("\n"));
    elements.push(backupLabel, backupList);
  }

  const codeInput = createElement("input", {
    class: "form-input", type: "text",
    placeholder: "6-digit code", maxlength: "6",
    style: "margin-bottom:12px",
    "data-testid": "totp-code-input",
  });

  const confirmError = createElement("div", {
    style: "color:var(--red);font-size:13px;margin-bottom:8px",
    "data-testid": "totp-error",
  });

  const confirmBtn = createElement("button", {
    class: "ac-btn",
    "data-testid": "totp-confirm-btn",
  }, "Verify & Activate");

  confirmBtn.addEventListener("click", () => {
    const code = codeInput.value.trim();
    if (code.length === 0) {
      setText(confirmError, "Please enter the 6-digit code.");
      return;
    }
    setText(confirmError, "");
    confirmBtn.disabled = true;
    setText(confirmBtn, "Verifying...");

    void options.onConfirmTotp(password, code).then(() => {
      onEnrolled();
    }).catch((err: unknown) => {
      setText(confirmError, err instanceof Error ? err.message : "Invalid verification code.");
      confirmBtn.disabled = false;
      setText(confirmBtn, "Verify & Activate");
    });
  }, { signal });

  elements.push(codeInput, confirmError, confirmBtn);
  appendChildren(container, ...elements);
}

function buildTotpDisableView(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
  onDisabled: () => void,
): HTMLDivElement {
  const wrapper = createElement("div", {});

  const description = createElement("div", {
    style: "color:var(--text-muted);font-size:13px;margin-bottom:12px",
  }, "Your account is protected with 2FA.");

  const disableBtn = createElement("button", {
    class: "ac-btn account-delete-btn",
    "data-testid": "totp-disable-btn",
  }, "Disable 2FA");

  const confirmArea = createElement("div", { style: "display:none" });
  const pwInput = createElement("input", {
    class: "form-input", type: "password",
    placeholder: "Enter your password", style: "margin-bottom:12px",
    "data-testid": "totp-password-input",
  });
  const errorEl = createElement("div", {
    style: "color:var(--red);font-size:13px;margin-bottom:8px",
    "data-testid": "totp-error",
  });
  const btnRow = createElement("div", { style: "display:flex;gap:8px" });
  const confirmBtn = createElement("button", { class: "ac-btn account-delete-btn" }, "Confirm Disable");
  const cancelBtn = createElement("button", {
    class: "ac-btn", style: "background:var(--bg-active)",
  }, "Cancel");
  appendChildren(btnRow, confirmBtn, cancelBtn);
  appendChildren(confirmArea, pwInput, errorEl, btnRow);

  disableBtn.addEventListener("click", () => {
    disableBtn.style.display = "none";
    confirmArea.style.display = "block";
    pwInput.value = "";
    setText(errorEl, "");
    pwInput.focus();
  }, { signal });

  cancelBtn.addEventListener("click", () => {
    confirmArea.style.display = "none";
    disableBtn.style.display = "";
    pwInput.value = "";
    setText(errorEl, "");
  }, { signal });

  confirmBtn.addEventListener("click", () => {
    const pw = pwInput.value;
    if (pw.length === 0) {
      setText(errorEl, "Password is required.");
      return;
    }
    setText(errorEl, "");
    confirmBtn.disabled = true;
    setText(confirmBtn, "Disabling...");

    void options.onDisableTotp(pw).then(() => {
      onDisabled();
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to disable 2FA.";
      const is403Required = msg.toLowerCase().includes("required");
      setText(errorEl, is403Required
        ? "2FA is required by this server and cannot be disabled"
        : msg);
      confirmBtn.disabled = false;
      setText(confirmBtn, "Confirm Disable");
    });
  }, { signal });

  appendChildren(wrapper, description, disableBtn, confirmArea);
  return wrapper;
}

function buildTotpSection(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const wrapper = createElement("div", { "data-testid": "totp-section" });

  const separator = createElement("div", { class: "settings-separator" });
  const headerRow = createElement("div", {
    style: "display:flex;align-items:center;gap:8px;margin-bottom:4px",
  });
  const header = createElement("div", {
    class: "settings-section-title",
    style: "margin-bottom:0",
  }, "Two-Factor Authentication");

  const statusBadge = createElement("span", {
    "data-testid": "totp-status-badge",
    style: "font-size:12px;padding:2px 8px;border-radius:4px;font-weight:600",
  });

  appendChildren(headerRow, header, statusBadge);

  const contentArea = createElement("div", {});

  function render(): void {
    const enabled = authStore.getState().user?.totp_enabled === true;

    if (enabled) {
      statusBadge.textContent = "Enabled";
      statusBadge.style.background = "var(--green, #3ba55d)";
      statusBadge.style.color = "#fff";
    } else {
      statusBadge.textContent = "Disabled";
      statusBadge.style.background = "var(--bg-active)";
      statusBadge.style.color = "var(--text-muted)";
    }

    while (contentArea.firstChild) {
      contentArea.removeChild(contentArea.firstChild);
    }

    if (enabled) {
      contentArea.appendChild(buildTotpDisableView(options, signal, render));
    } else {
      contentArea.appendChild(buildTotpEnrollForm(options, signal, render));
    }
  }

  render();

  appendChildren(wrapper, separator, headerRow, contentArea);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Status selector builder
// ---------------------------------------------------------------------------

interface StatusOption {
  readonly value: UserStatus;
  readonly label: string;
  readonly description: string;
  readonly color: string;
}

const STATUS_OPTIONS: readonly StatusOption[] = [
  { value: "online",  label: "Online",          description: "",                                                    color: "#3ba55d" },
  { value: "idle",    label: "Idle",             description: "You will appear as idle",                            color: "#faa61a" },
  { value: "dnd",     label: "Do Not Disturb",   description: "You will not receive desktop notifications",         color: "#ed4245" },
  { value: "offline", label: "Offline",            description: "You will appear offline but still have full access", color: "#747f8d" },
];

function buildStatusSelector(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const wrapper = createElement("div", {});
  const separator = createElement("div", { class: "settings-separator" });
  const sectionTitle = createElement("div", { class: "settings-section-title" }, "Status");
  const optionsList = createElement("div", { class: "settings-status-options" });

  const currentStatus = loadPref<UserStatus>("userStatus", "online");
  const rowElements = new Map<UserStatus, HTMLDivElement>();

  for (const opt of STATUS_OPTIONS) {
    const isActive = opt.value === currentStatus;
    const row = createElement("div", {
      class: `settings-status-option${isActive ? " active" : ""}`,
      role: "button",
      tabindex: "0",
      "aria-pressed": isActive ? "true" : "false",
    });

    const dot = createElement("div", { class: "settings-status-dot" });
    dot.style.background = opt.color;

    const labelWrap = createElement("div", {});
    const labelEl = createElement("div", { class: "settings-status-label" }, opt.label);
    appendChildren(labelWrap, labelEl);
    if (opt.description.length > 0) {
      const descEl = createElement("div", { class: "settings-status-desc" }, opt.description);
      labelWrap.appendChild(descEl);
    }

    appendChildren(row, dot, labelWrap);

    const selectStatus = (): void => {
      for (const [, el] of rowElements) {
        el.classList.remove("active");
        el.setAttribute("aria-pressed", "false");
      }
      row.classList.add("active");
      row.setAttribute("aria-pressed", "true");
      savePref("userStatus", opt.value);
      options.onStatusChange(opt.value);
    };

    row.addEventListener("click", selectStatus, { signal });
    row.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectStatus();
      }
    }, { signal });

    rowElements.set(opt.value, row);
    optionsList.appendChild(row);
  }

  appendChildren(wrapper, separator, sectionTitle, optionsList);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Delete account (danger zone) builder
// ---------------------------------------------------------------------------

function buildDeleteAccountSection(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const wrapper = createElement("div", {});

  const separator = createElement("div", { class: "settings-separator" });
  const header = createElement("div", {
    class: "settings-section-title",
    style: "color:var(--red)",
  }, "Danger Zone");

  const description = createElement("div", {
    style: "color:var(--text-muted);font-size:13px;margin-bottom:12px",
  }, "Permanently delete your account and all associated data.");

  const deleteBtn = createElement("button", {
    class: "ac-btn account-delete-btn",
    "data-testid": "delete-account-trigger",
  }, "Delete Account");

  // Inline confirmation area (hidden by default)
  const confirmArea = createElement("div", {
    class: "account-delete-confirm",
    style: "display:none",
    "data-testid": "delete-account-confirm-area",
  });

  const warningText = createElement("div", {
    style: "color:var(--red);font-size:13px;margin-bottom:12px;line-height:1.4",
  }, "This action is permanent and cannot be undone. All your data will be deleted. Enter your password to confirm.");

  const passwordInput = createElement("input", {
    class: "form-input",
    type: "password",
    placeholder: "Enter your password",
    style: "margin-bottom:12px",
    "data-testid": "delete-account-password",
  });

  const errorEl = createElement("div", {
    style: "color:var(--red);font-size:13px;margin-bottom:8px",
    "data-testid": "delete-account-error",
  });

  const btnRow = createElement("div", { style: "display:flex;gap:8px" });
  const confirmBtn = createElement("button", {
    class: "ac-btn account-delete-btn",
    "data-testid": "delete-account-confirm",
  }, "Confirm Delete");
  const cancelBtn = createElement("button", {
    class: "ac-btn",
    style: "background:var(--bg-active)",
  }, "Cancel");

  appendChildren(btnRow, confirmBtn, cancelBtn);
  appendChildren(confirmArea, warningText, passwordInput, errorEl, btnRow);

  // Show confirmation area
  deleteBtn.addEventListener("click", () => {
    deleteBtn.style.display = "none";
    confirmArea.style.display = "block";
    passwordInput.value = "";
    setText(errorEl, "");
    passwordInput.focus();
  }, { signal });

  // Cancel — hide confirmation
  cancelBtn.addEventListener("click", () => {
    confirmArea.style.display = "none";
    deleteBtn.style.display = "";
    passwordInput.value = "";
    setText(errorEl, "");
  }, { signal });

  // Confirm delete
  confirmBtn.addEventListener("click", () => {
    const pw = passwordInput.value;
    if (pw.length === 0) {
      setText(errorEl, "Password is required.");
      return;
    }
    setText(errorEl, "");
    confirmBtn.disabled = true;
    setText(confirmBtn, "Deleting...");

    void options.onDeleteAccount(pw).then(() => {
      // Success — cleanup is handled by the callback (clears auth, navigates away)
    }).catch((err: unknown) => {
      setText(errorEl, err instanceof Error ? err.message : "Failed to delete account.");
      confirmBtn.disabled = false;
      setText(confirmBtn, "Confirm Delete");
    });
  }, { signal });

  appendChildren(wrapper, separator, header, description, deleteBtn, confirmArea);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Main tab builder
// ---------------------------------------------------------------------------

const MAX_USERNAME_LEN = 32;

export function buildAccountTab(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });
  const user = authStore.getState().user;
  const username = user?.username ?? "Unknown";

  // Profile card
  const { card, headerName, usernameValue, editUserProfileBtn, editUsernameBtn } =
    buildProfileCard(username);
  section.appendChild(card);

  // Status selector
  section.appendChild(buildStatusSelector(options, signal));

  // Inline edit form
  const editForm = createElement("div", { class: "setting-row", style: "display:none;margin-bottom:16px" });
  const editInput = createElement("input", { class: "form-input", type: "text", placeholder: "New username" });
  const saveBtn = createElement("button", { class: "ac-btn" }, "Save");
  const cancelBtn = createElement("button", { class: "ac-btn", style: "background:var(--bg-active)" }, "Cancel");
  appendChildren(editForm, editInput, saveBtn, cancelBtn);

  const usernameError = createElement("div", { style: "color:var(--red);font-size:13px;margin-top:4px" });
  editForm.appendChild(usernameError);

  const openEditForm = () => {
    editForm.style.display = "flex";
    editInput.value = authStore.getState().user?.username ?? "";
    editInput.focus();
  };

  editUserProfileBtn.addEventListener("click", openEditForm, { signal });
  editUsernameBtn.addEventListener("click", openEditForm, { signal });

  cancelBtn.addEventListener("click", () => {
    editForm.style.display = "none";
    setText(usernameError, "");
  }, { signal });

  saveBtn.addEventListener("click", () => {
    const newName = editInput.value.trim();
    if (newName.length < 2 || newName.length > MAX_USERNAME_LEN) {
      setText(usernameError, `Username must be 2\u2013${MAX_USERNAME_LEN} characters.`);
      return;
    }
    setText(usernameError, "");
    void options.onUpdateProfile(newName).then(() => {
      setText(headerName, newName);
      setText(usernameValue, newName);
      editForm.style.display = "none";
    }).catch((err: unknown) => {
      setText(usernameError, err instanceof Error ? err.message : "Failed to update username.");
    });
  }, { signal });

  section.appendChild(editForm);

  // Password section
  section.appendChild(buildPasswordSection(options, signal));

  // Two-factor authentication section
  section.appendChild(buildTotpSection(options, signal));

  // Delete account (danger zone)
  section.appendChild(buildDeleteAccountSection(options, signal));

  return section;
}
