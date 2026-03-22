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
      pwError.style.color = "var(--green)";
      setText(pwError, "Password changed successfully.");
      setTimeout(() => { setText(pwError, ""); pwError.style.color = "var(--red)"; }, 3000);
    }).catch((err: unknown) => {
      setText(pwError, err instanceof Error ? err.message : "Failed to change password.");
    });
  }, { signal });

  appendChildren(wrapper, separator, pwHeader, oldPw, newPw, confirmPw, pwError, pwBtn);
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
  { value: "offline", label: "Invisible",        description: "You will appear offline but still have full access", color: "#747f8d" },
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
    const row = createElement("div", {
      class: `settings-status-option${opt.value === currentStatus ? " active" : ""}`,
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

    row.addEventListener("click", () => {
      for (const [, el] of rowElements) {
        el.classList.remove("active");
      }
      row.classList.add("active");
      savePref("userStatus", opt.value);
      options.onStatusChange(opt.value);
    }, { signal });

    rowElements.set(opt.value, row);
    optionsList.appendChild(row);
  }

  appendChildren(wrapper, separator, sectionTitle, optionsList);
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
    editInput.value = user?.username ?? "";
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
    if (newName.length === 0 || newName.length > MAX_USERNAME_LEN) {
      setText(usernameError, `Username must be 1\u2013${MAX_USERNAME_LEN} characters.`);
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

  return section;
}
