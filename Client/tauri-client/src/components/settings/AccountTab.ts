/**
 * Account settings tab — profile editing, password change, logout.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { authStore } from "@stores/auth.store";
import type { SettingsOverlayOptions } from "../SettingsOverlay";

export function buildAccountTab(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });
  const user = authStore.getState().user;

  // Account card
  const accountCard = createElement("div", { class: "account-card" });
  const acAvatar = createElement("div", {
    class: "ac-avatar",
    style: "background: var(--accent)",
  }, (user?.username ?? "U").charAt(0).toUpperCase());
  const acInfo = createElement("div", {});
  const acName = createElement("div", { class: "ac-name" }, user?.username ?? "Unknown");
  const acId = createElement("div", { class: "ac-id" }, `ID: ${user?.id ?? "?"}`);
  appendChildren(acInfo, acName, acId);
  const editBtn = createElement("button", { class: "ac-btn" }, "Edit Profile");
  appendChildren(accountCard, acAvatar, acInfo, editBtn);
  section.appendChild(accountCard);

  const editForm = createElement("div", { class: "setting-row", style: "display:none" });
  const editInput = createElement("input", { class: "form-input", type: "text", placeholder: "New username" });
  const saveBtn = createElement("button", { class: "ac-btn" }, "Save");
  const cancelBtn = createElement("button", { class: "ac-btn", style: "background:var(--bg-active)" }, "Cancel");
  const usernameValue = acName;
  appendChildren(editForm, editInput, saveBtn, cancelBtn);

  editBtn.addEventListener("click", () => {
    editForm.style.display = "flex";
    editInput.value = user?.username ?? "";
    editInput.focus();
  }, { signal });

  cancelBtn.addEventListener("click", () => {
    editForm.style.display = "none";
  }, { signal });

  const usernameError = createElement("div", { style: "color:var(--red);font-size:13px;margin-top:4px" });
  editForm.appendChild(usernameError);

  saveBtn.addEventListener("click", () => {
    const newName = editInput.value.trim();
    if (newName.length > 0) {
      setText(usernameError, "");
      void options.onUpdateProfile(newName).then(() => {
        setText(usernameValue, newName);
        editForm.style.display = "none";
      }).catch((err: unknown) => {
        setText(usernameError, err instanceof Error ? err.message : "Failed to update username.");
      });
    }
  }, { signal });

  section.appendChild(editForm);

  // Change password
  const pwHeader = createElement("h3", {}, "Change Password");
  const oldPw = createElement("input", { class: "form-input", type: "password", placeholder: "Old password", style: "margin-bottom:8px" });
  const newPw = createElement("input", { class: "form-input", type: "password", placeholder: "New password", style: "margin-bottom:8px" });
  const confirmPw = createElement("input", { class: "form-input", type: "password", placeholder: "Confirm new password", style: "margin-bottom:8px" });
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

  appendChildren(section, pwHeader, oldPw, newPw, confirmPw, pwError, pwBtn);

  // Logout
  const logoutBtn = createElement("button", {
    class: "settings-nav-item danger",
    style: "margin-top:16px;width:auto;padding:8px 16px",
  }, "Log Out");
  logoutBtn.addEventListener("click", () => options.onLogout(), { signal });
  section.appendChild(logoutBtn);

  return section;
}
