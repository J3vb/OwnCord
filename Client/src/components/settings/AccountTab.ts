/**
 * Account settings tab — profile editing, password change.
 * Discord-style profile card with colored banner, overlapping avatar,
 * and separated field rows.
 */

import { createElement, appendChildren, setText, focusIsOurs } from "@lib/dom";
import type { UserStatus } from "@lib/types";
import { ApiClientError, errorText } from "@lib/api";
import type { SessionInfo } from "@lib/api";
import { createLogger } from "@lib/logger";
import { showToast } from "@lib/toast";
import { sessionDeviceLabel } from "@lib/session-notice";
import { formatMessageTimestamp } from "@lib/formatting";
import { authStore } from "@stores/auth.store";
import { uiStore } from "@stores/ui.store";
import { loadUserStatus, saveUserStatus } from "@lib/userStatus";
import { avatarInitial, resolveDisplayName } from "@lib/avatar";
import { isRenderableAvatar } from "@components/message-list/avatar";
import {
  fetchImageAsObjectUrl,
  recoverEvictedImage,
  resolveServerUrl,
} from "@components/message-list/attachments";
import type { SettingsOverlayOptions } from "../SettingsOverlay";
import { buildRecoveryKitSection, buildRegenerateCodes, buildShownOnce } from "./RecoverySections";
import { outcomeEl, showOutcome } from "./helpers";
import {
  createDisclosure,
  createRevealToggle,
  createStatusRow,
  setStatusIcon,
  statusIcon,
  type StatusKind,
} from "../../features/settings/status";
import { accountText as t } from "../../i18n/account";

const log = createLogger("AccountTab");

/** Mirrors the server's caps so the form can bound itself instead of learning
 *  about the limits from a rejected request. */
const MAX_DISPLAY_NAME_LEN = 32;
const MAX_ABOUT_LEN = 300;
/** Mirrors maxAvatarFileBytes / maxAvatarDimension on the server. */
const MAX_AVATAR_BYTES = 1024 * 1024;
const MAX_AVATAR_DIMENSION = 1024;
const ACCEPTED_AVATAR_TYPES = "image/png,image/jpeg,image/webp";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProfileCardResult {
  readonly card: HTMLDivElement;
  readonly headerName: HTMLDivElement;
  readonly headerHandle: HTMLDivElement;
  readonly usernameValue: HTMLDivElement;
  readonly editUsernameBtn: HTMLButtonElement;
  /** The big avatar; the uploader swaps its contents on success. */
  readonly avatarLarge: HTMLDivElement;
  /** Opened by Edit profile: avatar, display name, about and username. */
  readonly editor: HTMLDivElement;
}

// ---------------------------------------------------------------------------
// Profile card builder
// ---------------------------------------------------------------------------

function buildProfileCard(
  displayName: string,
  username: string,
  signal: AbortSignal,
): ProfileCardResult {
  const card = createElement("div", { class: "account-card" });
  const banner = createElement("div", { class: "account-banner" });

  // Avatar overlapping the banner
  const avatarWrap = createElement("div", { class: "account-avatar-wrap" });
  const avatarLarge = createElement(
    "div",
    { class: "account-avatar-large", "data-testid": "account-avatar" },
    avatarInitial({ username, displayName }),
  );
  const statusDot = createElement("div", { class: "account-status-dot" });
  appendChildren(avatarWrap, avatarLarge, statusDot);

  // Header row
  const accountHeader = createElement("div", { class: "account-header" });
  const headerName = createElement("div", { class: "account-header-name" }, displayName);
  const headerHandle = createElement(
    "div",
    { class: "account-header-handle" },
    t("profile.handle", { username }),
  );
  const headerIdentity = createElement("div", { class: "account-header-identity" });
  appendChildren(headerIdentity, headerName, headerHandle);
  const editor = createElement("div", { class: "account-editor" });
  const editProfileBtn = createRevealToggle(
    t("profile.editProfile"),
    editor,
    signal,
    "profile-edit-toggle",
  );
  // The card's one accent action while closed; once open, Save Profile has it.
  editProfileBtn.classList.remove("secondary");
  editProfileBtn.addEventListener(
    "click",
    () => editProfileBtn.classList.toggle("secondary", !editor.hidden),
    { signal },
  );
  appendChildren(accountHeader, headerIdentity, editProfileBtn);

  // Username field row
  const fieldsContainer = createElement("div", { class: "account-fields" });
  const usernameField = createElement("div", { class: "account-field" });
  const usernameLeft = createElement("div", {});
  const usernameLabel = createElement(
    "div",
    { class: "account-field-label" },
    t("profile.username"),
  );
  const usernameValue = createElement("div", { class: "account-field-value" }, username);
  appendChildren(usernameLeft, usernameLabel, usernameValue);
  const editUsernameBtn = createElement(
    "button",
    { class: "account-field-edit" },
    t("profile.edit"),
  );
  appendChildren(usernameField, usernameLeft, editUsernameBtn);
  fieldsContainer.appendChild(usernameField);
  editor.appendChild(fieldsContainer);

  appendChildren(card, banner, avatarWrap, accountHeader, editor);

  return { card, headerName, headerHandle, usernameValue, editUsernameBtn, avatarLarge, editor };
}

// ---------------------------------------------------------------------------
// Avatar preview + uploader
// ---------------------------------------------------------------------------

/**
 * Draw `url` into the big avatar, replacing the letter. Falls back to the
 * letter when there is nothing to draw or the fetch fails, because the file
 * route is authenticated and `<img src>` cannot carry the session token.
 */
function paintAvatar(
  target: HTMLDivElement,
  url: string | null,
  alt: string,
  initial: string,
): void {
  const showInitial = (): void => {
    target.replaceChildren(document.createTextNode(initial));
    target.style.background = "";
  };
  if (url === null) {
    showInitial();
    return;
  }
  void fetchImageAsObjectUrl(url).then((objectUrl) => {
    if (objectUrl === null || !target.isConnected) return;
    const img = createElement("img", { class: "avatar-img", src: objectUrl, alt });
    recoverEvictedImage(img, { url });
    target.replaceChildren(img);
    target.style.background = "transparent";
  });
}

/**
 * Read a File into an object URL and measure it, so an image the server would
 * refuse is caught before a megabyte goes over the wire — and so the preview
 * shows what was actually picked rather than a spinner that ends in a 400.
 */
function measureImage(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.addEventListener(
      "load",
      () => {
        URL.revokeObjectURL(url);
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      },
      { once: true },
    );
    img.addEventListener(
      "error",
      () => {
        URL.revokeObjectURL(url);
        resolve(null);
      },
      { once: true },
    );
    img.src = url;
  });
}

/** Local validation mirroring the server's rules. Returns an error message. */
export function validateAvatarFile(
  file: { size: number; type: string },
  dimensions: { width: number; height: number } | null,
): string | null {
  if (!ACCEPTED_AVATAR_TYPES.split(",").includes(file.type)) {
    return t("avatar.notImage");
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return t("avatar.tooLarge", { kb: String(MAX_AVATAR_BYTES / 1024) });
  }
  if (dimensions === null) {
    return t("avatar.unreadable");
  }
  if (dimensions.width > MAX_AVATAR_DIMENSION || dimensions.height > MAX_AVATAR_DIMENSION) {
    return t("avatar.tooWide", {
      width: String(MAX_AVATAR_DIMENSION),
      height: String(MAX_AVATAR_DIMENSION),
    });
  }
  return null;
}

function buildAvatarUploader(
  options: SettingsOverlayOptions,
  avatarLarge: HTMLDivElement,
  signal: AbortSignal,
): HTMLDivElement {
  const wrapper = createElement("div", { class: "account-avatar-upload" });
  const input = createElement("input", {
    type: "file",
    accept: ACCEPTED_AVATAR_TYPES,
    style: "display:none",
    "data-testid": "avatar-file-input",
  });
  const uploadBtn = createElement(
    "button",
    { class: "ac-btn secondary", "data-testid": "avatar-upload-btn" },
    t("profile.changeAvatar"),
  );
  const errorEl = outcomeEl("error", "avatar-error");

  uploadBtn.addEventListener("click", () => input.click(), { signal });

  input.addEventListener(
    "change",
    () => {
      const file = input.files?.[0];
      if (file === undefined) return;
      setText(errorEl, "");
      void (async () => {
        const dimensions = await measureImage(file);
        const problem = validateAvatarFile(file, dimensions);
        if (problem !== null) {
          setText(errorEl, problem);
          input.value = "";
          return;
        }
        uploadBtn.disabled = true;
        setText(uploadBtn, t("profile.uploading"));
        try {
          const url = await options.onUploadAvatar(file);
          const user = authStore.getState().user;
          paintAvatar(
            avatarLarge,
            resolveServerUrl(url),
            user?.username ?? "avatar",
            avatarInitial({
              username: user?.username ?? "?",
              displayName: user?.display_name ?? null,
            }),
          );
        } catch (err) {
          setText(errorEl, errorText(err, t("profile.uploadFailed")));
        } finally {
          input.value = "";
          uploadBtn.disabled = false;
          setText(uploadBtn, t("profile.changeAvatar"));
        }
      })();
    },
    { signal },
  );

  appendChildren(wrapper, input, uploadBtn, errorEl);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Display name + about
// ---------------------------------------------------------------------------

function buildProfileFields(
  options: SettingsOverlayOptions,
  onSaved: (displayName: string) => void,
  signal: AbortSignal,
): HTMLDivElement {
  const wrapper = createElement("div", {});
  const separator = createElement("div", { class: "settings-separator" });
  const header = createElement(
    "div",
    { class: "settings-section-title" },
    t("profile.sectionTitle"),
  );

  const user = authStore.getState().user;

  const nameLabel = createElement(
    "div",
    { class: "account-field-label" },
    t("profile.displayName"),
  );
  const nameInput = createElement("input", {
    class: "form-input",
    type: "text",
    placeholder: t("profile.displayNamePlaceholder"),
    maxlength: String(MAX_DISPLAY_NAME_LEN),
    style: "margin-bottom:12px",
    "data-testid": "display-name-input",
  });
  nameInput.value = user?.display_name ?? "";

  const aboutLabel = createElement("div", { class: "account-field-label" }, t("profile.about"));
  const aboutInput = createElement("textarea", {
    class: "form-input",
    rows: "3",
    placeholder: t("profile.aboutPlaceholder"),
    maxlength: String(MAX_ABOUT_LEN),
    style: "margin-bottom:8px;resize:vertical",
    "data-testid": "about-input",
  });
  aboutInput.value = user?.about ?? "";

  const statusEl = outcomeEl("error", "profile-error");
  statusEl.style.marginBottom = "8px";
  const saveBtn = createElement(
    "button",
    { class: "ac-btn", "data-testid": "profile-save-btn" },
    t("profile.save"),
  );

  saveBtn.addEventListener(
    "click",
    () => {
      const displayName = nameInput.value.trim();
      const about = aboutInput.value.trim();
      // Both are sent unconditionally, empty string included: "" is how the
      // API says "clear it", and omitting a field means "leave it alone".
      showOutcome(statusEl, "error", "");
      saveBtn.disabled = true;
      setText(saveBtn, t("profile.saving"));
      void options
        .onUpdateProfile({ display_name: displayName, about })
        .then(() => {
          showOutcome(statusEl, "success", t("profile.saved"));
          onSaved(
            displayName.length > 0 ? displayName : (authStore.getState().user?.username ?? ""),
          );
        })
        .catch((err: unknown) => {
          showOutcome(statusEl, "error", errorText(err, t("profile.saveFailed")));
        })
        .finally(() => {
          saveBtn.disabled = false;
          setText(saveBtn, t("profile.save"));
          if (focusIsOurs(saveBtn)) saveBtn.focus();
        });
    },
    { signal },
  );

  appendChildren(
    wrapper,
    separator,
    header,
    nameLabel,
    nameInput,
    aboutLabel,
    aboutInput,
    statusEl,
    saveBtn,
  );
  return wrapper;
}

// ---------------------------------------------------------------------------
// Password section builder
// ---------------------------------------------------------------------------

/** A labelled password field for the password-change form. */
function passwordField(
  id: string,
  label: string,
  placeholder: string,
): { wrapper: HTMLDivElement; input: HTMLInputElement } {
  const wrapper = createElement("div", {});
  const labelEl = createElement("label", { class: "form-label", for: id }, label);
  const input = createElement("input", {
    class: "form-input",
    type: "password",
    id,
    placeholder,
    style: "margin:4px 0 12px",
  });
  appendChildren(wrapper, labelEl, input);
  return { wrapper, input };
}

function buildPasswordSection(options: SettingsOverlayOptions, signal: AbortSignal): HTMLLIElement {
  const { row, icon, result, body } = createStatusRow(
    t("password.sectionTitle"),
    "password-section",
  );
  setStatusIcon(icon, "ok");
  setText(result, t("password.set"));
  // The form opens on demand: changing a password is rare.
  const wrapper = createElement("div", {});
  row.insertBefore(
    createRevealToggle(t("password.changeToggle"), wrapper, signal, "password-change-toggle"),
    body,
  );
  body.appendChild(wrapper);

  const oldField = passwordField("pw-old", t("password.old"), t("password.old"));
  const newField = passwordField("pw-new", t("password.new"), t("password.new"));
  const confirmField = passwordField("pw-confirm", t("password.confirm"), t("password.confirm"));
  const oldPw = oldField.input;
  const newPw = newField.input;
  const confirmPw = confirmField.input;
  const pwError = outcomeEl("error", "pw-change-status");
  pwError.style.marginBottom = "8px";
  const pwBtn = createElement("button", { class: "ac-btn" }, t("password.change"));
  let pwSuccessTimer: ReturnType<typeof setTimeout> | null = null;

  pwBtn.addEventListener(
    "click",
    () => {
      const oldVal = oldPw.value;
      const newVal = newPw.value;
      const confirmVal = confirmPw.value;

      showOutcome(pwError, "error", "");
      if (oldVal.length === 0) {
        setText(pwError, t("password.enterCurrent"));
        return;
      }
      if (newVal.length < 8) {
        setText(pwError, t("password.tooShort"));
        return;
      }
      if (newVal !== confirmVal) {
        setText(pwError, t("password.mismatch"));
        return;
      }
      setText(pwError, "");
      // In-flight state: a second click would burn an attempt against the
      // server's lockout counter with the same credentials.
      pwBtn.disabled = true;
      setText(pwBtn, t("password.changing"));
      const finish = (): void => {
        pwBtn.disabled = false;
        setText(pwBtn, t("password.change"));
        if (focusIsOurs(pwBtn)) pwBtn.focus();
      };
      void options
        .onChangePassword(oldVal, newVal)
        .then((outcome) => {
          oldPw.value = "";
          newPw.value = "";
          confirmPw.value = "";
          if (pwSuccessTimer !== null) {
            clearTimeout(pwSuccessTimer);
            pwSuccessTimer = null;
          }
          const warning = outcome?.warning;
          if (warning !== undefined && warning !== "") {
            // A partial success (OC-0314): the password changed, but the
            // other sessions could not be revoked. The warning is the
            // instruction to revoke them by hand, so it stays in the form
            // — no green "changed successfully", no three-second fade.
            showOutcome(pwError, "warning", warning);
          } else {
            showOutcome(pwError, "success", t("password.changed"));
            pwSuccessTimer = setTimeout(() => {
              showOutcome(pwError, "error", "");
              pwSuccessTimer = null;
            }, 3000);
          }
          finish();
        })
        .catch((err: unknown) => {
          showOutcome(pwError, "error", errorText(err, t("password.changeFailed")));
          finish();
        });
    },
    { signal },
  );

  appendChildren(wrapper, oldField.wrapper, newField.wrapper, confirmField.wrapper, pwError, pwBtn);
  return row;
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

  const description = createElement(
    "div",
    {
      style: "color:var(--text-muted);font-size:13px;margin-bottom:12px",
    },
    t("totp.description"),
  );

  const enableBtn = createElement(
    "button",
    {
      class: "ac-btn",
      "data-testid": "totp-enable-btn",
    },
    t("totp.enable"),
  );

  const formArea = createElement("div", { style: "display:none" });
  const pwInput = createElement("input", {
    class: "form-input",
    type: "password",
    placeholder: t("totp.passwordPlaceholder"),
    style: "margin-bottom:12px",
    "data-testid": "totp-password-input",
  });
  const errorEl = outcomeEl("error", "totp-error");
  errorEl.style.marginBottom = "8px";
  const submitBtn = createElement("button", { class: "ac-btn" }, t("totp.submit"));

  appendChildren(formArea, pwInput, errorEl, submitBtn);

  const enrollArea = createElement("div", { style: "display:none" });

  enableBtn.addEventListener(
    "click",
    () => {
      enableBtn.style.display = "none";
      formArea.style.display = "block";
      pwInput.value = "";
      setText(errorEl, "");
      pwInput.focus();
    },
    { signal },
  );

  submitBtn.addEventListener(
    "click",
    () => {
      const pw = pwInput.value;
      if (pw.length === 0) {
        setText(errorEl, t("password.required"));
        return;
      }
      setText(errorEl, "");
      submitBtn.disabled = true;
      setText(submitBtn, t("totp.requesting"));

      void options
        .onEnableTotp(pw)
        .then((result) => {
          const restoreFocus = focusIsOurs(formArea);
          formArea.style.display = "none";
          buildTotpConfirmArea(enrollArea, options, pw, result, signal, onEnrolled);
          enrollArea.style.display = "block";
          submitBtn.disabled = false;
          setText(submitBtn, t("totp.submit"));
          if (restoreFocus) enrollArea.querySelector<HTMLElement>("button, input")?.focus();
        })
        .catch((err: unknown) => {
          setText(errorEl, errorText(err, t("totp.enableFailed")));
          submitBtn.disabled = false;
          setText(submitBtn, t("totp.submit"));
          if (focusIsOurs(submitBtn)) submitBtn.focus();
        });
    },
    { signal },
  );

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

  const qrLabel = createElement(
    "div",
    {
      style: "color:var(--text-muted);font-size:13px;margin-bottom:8px",
    },
    t("totp.scanUri"),
  );

  const qrUri = createElement(
    "code",
    {
      style:
        "display:block;background:var(--bg-active);padding:8px 12px;border-radius:6px;" +
        "font-family:monospace;font-size:12px;word-break:break-all;margin-bottom:12px;" +
        "color:var(--text-primary);user-select:all",
      "data-testid": "totp-qr-uri",
    },
    result.qr_uri,
  );

  const elements: HTMLElement[] = [qrLabel, qrUri];

  if (result.backup_codes.length > 0) {
    // These codes are shown exactly once — the confirm step replaces this view.
    // Say so, and give a one-click way to keep them.
    const reveal = buildShownOnce(
      {
        warning: t("totp.backupWarning"),
        text: result.backup_codes.join("\n"),
        codeTestId: "totp-backup-codes",
        copyTestId: "totp-copy-backup-codes",
        copyLabel: t("totp.copyCodes"),
      },
      signal,
    );
    elements.push(reveal.element);
  }

  const codeInput = createElement("input", {
    class: "form-input",
    type: "text",
    placeholder: t("totp.codePlaceholder"),
    maxlength: "6",
    style: "margin-bottom:12px",
    "data-testid": "totp-code-input",
  });

  const confirmError = outcomeEl("error", "totp-error");
  confirmError.style.marginBottom = "8px";

  const confirmBtn = createElement(
    "button",
    {
      class: "ac-btn",
      "data-testid": "totp-confirm-btn",
    },
    t("totp.verify"),
  );

  confirmBtn.addEventListener(
    "click",
    () => {
      const code = codeInput.value.trim();
      if (!/^\d{6}$/.test(code)) {
        setText(confirmError, t("totp.codeInvalid"));
        return;
      }
      setText(confirmError, "");
      confirmBtn.disabled = true;
      setText(confirmBtn, t("totp.verifying"));

      void options
        .onConfirmTotp(password, code)
        .then(() => {
          onEnrolled();
        })
        .catch((err: unknown) => {
          setText(confirmError, errorText(err, t("totp.enableFailed")));
          confirmBtn.disabled = false;
          setText(confirmBtn, t("totp.verify"));
          if (focusIsOurs(confirmBtn)) confirmBtn.focus();
        });
    },
    { signal },
  );

  elements.push(codeInput, confirmError, confirmBtn);
  appendChildren(container, ...elements);
}

function buildTotpDisableView(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
  onDisabled: () => void,
): HTMLDivElement {
  const wrapper = createElement("div", {});

  const description = createElement(
    "div",
    {
      style: "color:var(--text-muted);font-size:13px;margin-bottom:12px",
    },
    t("totp.protected"),
  );

  const disableBtn = createElement(
    "button",
    {
      class: "ac-btn secondary destructive",
      "data-testid": "totp-disable-btn",
    },
    t("totp.disable"),
  );

  const confirmArea = createElement("div", { style: "display:none" });
  const pwInput = createElement("input", {
    class: "form-input",
    type: "password",
    placeholder: t("totp.passwordPlaceholder"),
    style: "margin-bottom:12px",
    "data-testid": "totp-password-input",
  });
  const errorEl = outcomeEl("error", "totp-error");
  errorEl.style.marginBottom = "8px";
  const btnRow = createElement("div", { style: "display:flex;gap:8px" });
  const confirmBtn = createElement(
    "button",
    { class: "ac-btn account-delete-btn" },
    t("totp.confirmDisable"),
  );
  const cancelBtn = createElement("button", { class: "ac-btn secondary" }, t("recovery.cancel"));
  appendChildren(btnRow, confirmBtn, cancelBtn);
  appendChildren(confirmArea, pwInput, errorEl, btnRow);

  disableBtn.addEventListener(
    "click",
    () => {
      disableBtn.style.display = "none";
      confirmArea.style.display = "block";
      pwInput.value = "";
      setText(errorEl, "");
      pwInput.focus();
    },
    { signal },
  );

  cancelBtn.addEventListener(
    "click",
    () => {
      confirmArea.style.display = "none";
      disableBtn.style.display = "";
      pwInput.value = "";
      setText(errorEl, "");
      if (focusIsOurs(confirmArea)) disableBtn.focus();
    },
    { signal },
  );

  confirmBtn.addEventListener(
    "click",
    () => {
      const pw = pwInput.value;
      if (pw.length === 0) {
        setText(errorEl, t("password.required"));
        return;
      }
      setText(errorEl, "");
      confirmBtn.disabled = true;
      setText(confirmBtn, t("totp.disabling"));

      void options
        .onDisableTotp(pw)
        .then(() => {
          onDisabled();
        })
        .catch((err: unknown) => {
          const requiredByServer = err instanceof ApiClientError && err.code === "FORBIDDEN";
          setText(
            errorEl,
            requiredByServer ? t("totp.requiredByServer") : errorText(err, t("totp.disableFailed")),
          );
          confirmBtn.disabled = false;
          setText(confirmBtn, t("totp.confirmDisable"));
          if (focusIsOurs(confirmBtn)) confirmBtn.focus();
        });
    },
    { signal },
  );

  appendChildren(wrapper, description, disableBtn, confirmArea);
  return wrapper;
}

function buildTotpSection(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
  onState: (state: StatusKind) => void,
): HTMLLIElement {
  const { row, icon, result, body } = createStatusRow(t("totp.sectionTitle"), "totp-section");
  // The state word keeps its test hook; the hint says what "off" means.
  const statusBadge = createElement("span", {
    class: "status-state",
    "data-testid": "totp-status-badge",
  });
  const offHint = createElement("span", {}, t("totp.offHint"));
  result.append(statusBadge, " ", offHint);

  const contentArea = createElement("div", {});

  function render(afterSubmit = false): void {
    const enabled = authStore.getState().user?.totp_enabled === true;
    // The control the user just activated is being replaced, and removing it
    // drops focus to <body> (B9-23). Unless the user has moved focus
    // elsewhere, move it to the first rebuilt control instead.
    const restoreFocus = afterSubmit && focusIsOurs(contentArea);

    // The words "Enabled"/"Disabled" carry the state; the icon only repeats it.
    statusBadge.textContent = enabled ? t("totp.enabled") : t("totp.disabled");
    offHint.hidden = enabled;
    const state: StatusKind = enabled ? "ok" : "warn";
    setStatusIcon(icon, state);
    onState(state);

    while (contentArea.firstChild) {
      contentArea.removeChild(contentArea.firstChild);
    }

    if (enabled) {
      contentArea.appendChild(buildTotpDisableView(options, signal, () => render(true)));
      contentArea.appendChild(buildRegenerateCodes(options, signal));
    } else {
      contentArea.appendChild(buildTotpEnrollForm(options, signal, () => render(true)));
    }
    if (restoreFocus) {
      contentArea.querySelector<HTMLElement>("button, [tabindex]")?.focus();
    }
  }

  render();

  // auth_ok never carries totp_enabled, so the store's value can be a stale
  // default until the profile has been read (OC-0354). Refresh when the
  // section opens; rebuild only if the answer differs from what is shown,
  // so a form the user already started is not thrown away.
  const shownEnabled = authStore.getState().user?.totp_enabled === true;
  void options
    .onRefreshTotpStatus()
    .then(() => {
      if ((authStore.getState().user?.totp_enabled === true) !== shownEnabled) render();
    })
    .catch((err) => {
      log.warn("Failed to refresh TOTP status — showing cached state", err);
    });

  body.appendChild(contentArea);
  return row;
}

// ---------------------------------------------------------------------------
// Status selector builder
// ---------------------------------------------------------------------------

const STATUS_OPTIONS: readonly { readonly value: UserStatus; readonly label: string }[] = [
  { value: "online", label: t("status.online") },
  { value: "idle", label: t("status.idle") },
  { value: "dnd", label: t("status.dnd") },
  // Its own status now, not "offline" relabeled: the server stores it as
  // chosen, shows everyone else offline, and honours it across reconnects.
  { value: "invisible", label: t("status.invisible") },
];

/** One labelled select; only Do Not Disturb's side effect needs saying. */
function buildStatusSelector(options: SettingsOverlayOptions, signal: AbortSignal): HTMLDivElement {
  const wrapper = createElement("div", {});
  const row = createElement("div", { class: "setting-row" });
  const info = createElement("div", {});
  appendChildren(
    info,
    createElement("label", { class: "setting-label", for: "status-select" }, t("status.showMeAs")),
    createElement("div", { class: "setting-desc" }, t("status.hint")),
  );
  const select = createElement("select", {
    class: "settings-select",
    id: "status-select",
    "data-testid": "status-select",
  });
  for (const opt of STATUS_OPTIONS) {
    select.appendChild(createElement("option", { value: opt.value }, opt.label));
  }
  select.value = loadUserStatus();
  select.addEventListener(
    "change",
    () => {
      const status = select.value as UserStatus;
      saveUserStatus(status);
      options.onStatusChange(status);
    },
    { signal },
  );
  appendChildren(row, info, select);
  appendChildren(
    wrapper,
    createElement("div", { class: "settings-section-title" }, t("status.sectionTitle")),
    row,
  );
  return wrapper;
}

// ---------------------------------------------------------------------------
// Devices (sessions) builder
// ---------------------------------------------------------------------------

function buildSessionRow(
  s: SessionInfo,
  options: SettingsOverlayOptions,
  signal: AbortSignal,
  onListChanged: () => void,
): HTMLDivElement {
  const row = createElement("div", {
    class: "session-row",
    "data-testid": "session-row",
    "data-session-id": String(s.id),
  });
  const info = createElement("div", { class: "session-info" });
  const name = createElement("div", { class: "session-device" }, sessionDeviceLabel(s.device));
  if (s.is_current) {
    name.appendChild(createElement("span", { class: "session-current" }, t("devices.thisDevice")));
  }
  const detail = createElement(
    "div",
    { class: "session-detail" },
    t("devices.detail", {
      ip: s.ip === "" ? t("devices.unknownIp") : s.ip,
      time: formatMessageTimestamp(s.last_used),
    }),
  );
  appendChildren(info, name, detail);
  row.appendChild(info);

  // The current device has no per-row action: "Sign out everywhere" covers it.
  if (s.is_current) return row;

  const revokeBtn = createElement(
    "button",
    { class: "ac-btn secondary", "data-testid": "session-revoke" },
    t("devices.signOut"),
  );
  revokeBtn.addEventListener(
    "click",
    () => {
      const list = row.parentElement;
      const next = row.nextSibling;
      row.remove();
      void options
        .onRevokeSession(s.id)
        .then(() => {
          onListChanged();
          showToast(
            uiStore.getState().sessionReplaced
              ? t("devices.signedOutReplaced")
              : t("devices.signedOut"),
            "success",
          );
        })
        .catch((err: unknown) => {
          // The server kept the session, so the row comes back.
          if (next?.parentNode === list) list?.insertBefore(row, next);
          else list?.appendChild(row);
          onListChanged();
          showToast(errorText(err, t("devices.signOutFailed")), "error");
        });
    },
    { signal },
  );
  row.appendChild(revokeBtn);
  return row;
}

function buildSessionsSection(options: SettingsOverlayOptions, signal: AbortSignal): HTMLLIElement {
  const { row, icon, result, body } = createStatusRow(
    t("devices.sectionTitle"),
    "sessions-section",
  );
  const panel = createElement("div", {});
  row.insertBefore(createRevealToggle(t("devices.manage"), panel, signal, "sessions-manage"), body);
  body.appendChild(panel);
  const description = createElement("div", { class: "setting-desc" }, t("devices.description"));
  const list = createElement("div", { class: "session-list", "data-testid": "sessions-list" });
  const status = createElement(
    "div",
    { style: "color:var(--text-muted);font-size:13px" },
    t("devices.loading"),
  );

  const recount = (): void => {
    setText(result, t("devices.count", { count: list.childElementCount }));
  };

  function load(): void {
    list.replaceChildren(status);
    setText(status, t("devices.loading"));
    setText(result, t("devices.loading"));
    setStatusIcon(icon, "pending");
    void options
      .onListSessions()
      .then((sessions) => {
        if (signal.aborted) return;
        list.replaceChildren(...sessions.map((s) => buildSessionRow(s, options, signal, recount)));
        recount();
        setStatusIcon(icon, "ok");
      })
      .catch((err: unknown) => {
        if (signal.aborted) return;
        log.warn("Failed to list sessions", err);
        setText(status, t("devices.loadFailed"));
        setText(result, t("devices.loadFailed"));
        setStatusIcon(icon, "warn");
      });
  }

  const revokeAllBtn = createElement(
    "button",
    {
      class: "ac-btn secondary destructive",
      style: "margin-top:12px",
      "data-testid": "sessions-revoke-all",
    },
    t("devices.signOutEverywhere"),
  );
  const confirmArea = createElement("div", {
    style: "display:none;margin-top:12px",
    "data-testid": "sessions-revoke-all-confirm-area",
  });
  const warning = createElement(
    "div",
    { style: "color:var(--text-danger);font-size:13px;margin-bottom:12px;line-height:1.4" },
    t("devices.signOutEverywhereWarning"),
  );
  const errorEl = outcomeEl("error");
  errorEl.style.marginBottom = "8px";
  const btnRow = createElement("div", { style: "display:flex;gap:8px" });
  const confirmBtn = createElement(
    "button",
    { class: "ac-btn account-delete-btn", "data-testid": "sessions-revoke-all-confirm" },
    t("devices.signOutEverywhere"),
  );
  const cancelBtn = createElement("button", { class: "ac-btn secondary" }, t("recovery.cancel"));
  appendChildren(btnRow, confirmBtn, cancelBtn);
  appendChildren(confirmArea, warning, errorEl, btnRow);

  const closeConfirm = (): void => {
    confirmArea.style.display = "none";
    revokeAllBtn.style.display = "";
    setText(errorEl, "");
    if (focusIsOurs(confirmArea)) revokeAllBtn.focus();
  };
  revokeAllBtn.addEventListener(
    "click",
    () => {
      revokeAllBtn.style.display = "none";
      confirmArea.style.display = "block";
      cancelBtn.focus();
    },
    { signal },
  );
  cancelBtn.addEventListener("click", closeConfirm, { signal });
  confirmBtn.addEventListener(
    "click",
    () => {
      confirmBtn.disabled = true;
      setText(errorEl, "");
      void options
        .onRevokeAllSessions()
        .then((revoked) => {
          // A revoked current session is handled by the page: auth is
          // cleared and the app leaves. Otherwise refresh what is left.
          if (revoked.current_session_revoked || signal.aborted) return;
          closeConfirm();
          load();
        })
        .catch((err: unknown) => {
          setText(errorEl, errorText(err, t("devices.signOutEverywhereFailed")));
          confirmBtn.disabled = false;
          if (focusIsOurs(confirmBtn)) confirmBtn.focus();
        })
        .finally(() => {
          confirmBtn.disabled = false;
        });
    },
    { signal },
  );

  appendChildren(panel, description, list, revokeAllBtn, confirmArea);
  load();
  return row;
}

// ---------------------------------------------------------------------------
// Message retention (B7-15c)
// ---------------------------------------------------------------------------

/** The server-default retention window, when the server reported one. */
function buildRetentionSection(notice: string): HTMLDivElement {
  const wrapper = createElement("div", { "data-testid": "account-retention" });
  appendChildren(
    wrapper,
    createElement("div", { class: "settings-separator" }),
    createElement("div", { class: "settings-section-title" }, t("retention.sectionTitle")),
    createElement("div", { style: "color:var(--text-muted);font-size:13px" }, notice),
  );
  return wrapper;
}

// ---------------------------------------------------------------------------
// Delete account (danger zone) builder
// ---------------------------------------------------------------------------

function buildDeleteAccountSection(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
): HTMLDetailsElement {
  // Rarely needed and irreversible: behind a closed disclosure, last.
  const { details: wrapper } = createDisclosure(t("delete.sectionTitle"));
  wrapper.classList.add("danger-zone");

  const description = createElement(
    "div",
    {
      style: "color:var(--text-muted);font-size:13px;margin-bottom:12px",
    },
    t("delete.description"),
  );

  const deleteBtn = createElement(
    "button",
    {
      class: "ac-btn secondary destructive",
      "data-testid": "delete-account-trigger",
    },
    t("delete.button"),
  );

  // Inline confirmation area (hidden by default)
  const confirmArea = createElement("div", {
    class: "account-delete-confirm",
    style: "display:none",
    "data-testid": "delete-account-confirm-area",
  });

  const warningText = createElement(
    "div",
    {
      style: "color:var(--text-danger);font-size:13px;margin-bottom:12px;line-height:1.4",
    },
    // B7-15c owner decision: no retention window here. Erasure hard-deletes
    // the account's messages and attachments at once (Server/db/erasure.go),
    // so a "kept N days" line would imply a grace period that does not exist.
    t("delete.warning"),
  );

  const passwordLabel = createElement(
    "label",
    { class: "form-label", for: "delete-account-password" },
    // Same text as the placeholder, so the field's accessible name is
    // unchanged by gaining a real <label> (B9-23).
    t("totp.passwordPlaceholder"),
  );
  const passwordInput = createElement("input", {
    class: "form-input",
    type: "password",
    id: "delete-account-password",
    placeholder: t("totp.passwordPlaceholder"),
    style: "margin:4px 0 12px",
    "data-testid": "delete-account-password",
    "aria-describedby": "delete-account-error",
  });

  const errorEl = outcomeEl("error", "delete-account-error");
  errorEl.id = "delete-account-error";
  errorEl.style.marginBottom = "8px";

  const btnRow = createElement("div", { style: "display:flex;gap:8px" });
  const confirmBtn = createElement(
    "button",
    {
      class: "ac-btn account-delete-btn",
      "data-testid": "delete-account-confirm",
    },
    t("delete.confirm"),
  );
  const cancelBtn = createElement("button", { class: "ac-btn secondary" }, t("recovery.cancel"));

  appendChildren(btnRow, confirmBtn, cancelBtn);
  appendChildren(confirmArea, warningText, passwordLabel, passwordInput, errorEl, btnRow);

  // Show confirmation area
  deleteBtn.addEventListener(
    "click",
    () => {
      deleteBtn.style.display = "none";
      confirmArea.style.display = "block";
      passwordInput.value = "";
      setText(errorEl, "");
      passwordInput.focus();
    },
    { signal },
  );

  // Cancel — hide confirmation
  cancelBtn.addEventListener(
    "click",
    () => {
      confirmArea.style.display = "none";
      deleteBtn.style.display = "";
      passwordInput.value = "";
      setText(errorEl, "");
      if (focusIsOurs(confirmArea)) deleteBtn.focus();
    },
    { signal },
  );

  // Confirm delete
  confirmBtn.addEventListener(
    "click",
    () => {
      const pw = passwordInput.value;
      if (pw.length === 0) {
        setText(errorEl, t("password.required"));
        return;
      }
      setText(errorEl, "");
      confirmBtn.disabled = true;
      setText(confirmBtn, t("delete.deleting"));

      void options
        .onDeleteAccount(pw)
        .then(() => {
          // Success — cleanup is handled by the callback (clears auth, navigates away)
        })
        .catch((err: unknown) => {
          setText(errorEl, errorText(err, t("delete.failed")));
          confirmBtn.disabled = false;
          setText(confirmBtn, t("delete.confirm"));
          if (focusIsOurs(confirmBtn)) confirmBtn.focus();
        });
    },
    { signal },
  );

  appendChildren(wrapper, description, deleteBtn, confirmArea);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Security card: the account's protection at a glance, forms on demand
// ---------------------------------------------------------------------------

function buildSecurityCard(options: SettingsOverlayOptions, signal: AbortSignal): HTMLElement {
  const card = createElement("section", {
    class: "settings-card account-security",
    "data-testid": "security-card",
    "aria-labelledby": "account-security-title",
  });
  const head = createElement("div", { class: "settings-card-head" });
  const pill = createElement("span", { class: "status-pill", "data-testid": "security-summary" });
  const pillIcon = statusIcon("pending");
  const pillText = createElement("span", {});
  pill.append(pillIcon, pillText);
  appendChildren(
    head,
    createElement("h3", { id: "account-security-title" }, t("security.title")),
    pill,
  );

  const list = createElement("ul", { class: "status-list" });

  // Two-factor and the recovery kit are the recommended steps; the pill
  // counts the ones still open. The next open step holds the card's accent:
  // Enable 2FA while two-factor is off, then the recovery-kit trigger.
  const states = new Map<string, StatusKind>();
  const paintNextStep = (): void => {
    const kitIsNext = states.get("totp") === "ok" && states.get("recovery") === "warn";
    list
      .querySelector("[data-testid='recovery-kit-btn']")
      ?.classList.toggle("secondary", !kitIsNext);
  };
  const report =
    (key: string) =>
    (state: StatusKind): void => {
      states.set(key, state);
      const open = [...states.values()].filter((s) => s === "warn").length;
      const known = states.size === 2 && ![...states.values()].includes("pending");
      pill.hidden = open === 0 && !known;
      setStatusIcon(pillIcon, open > 0 ? "warn" : "ok");
      setText(pillText, open > 0 ? t("security.steps", { count: open }) : t("security.allSet"));
      paintNextStep();
    };

  appendChildren(
    list,
    buildTotpSection(options, signal, report("totp")),
    buildRecoveryKitSection(options, signal, report("recovery")),
    buildPasswordSection(options, signal),
    buildSessionsSection(options, signal),
  );
  paintNextStep();
  appendChildren(card, head, list);
  return card;
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
  const username = user?.username ?? t("profile.unknown");
  const displayName = resolveDisplayName({
    username,
    displayName: user?.display_name ?? null,
  });

  // Profile card
  const { card, headerName, headerHandle, usernameValue, editUsernameBtn, avatarLarge, editor } =
    buildProfileCard(displayName, username, signal);
  section.appendChild(card);

  // Existing avatar, if any — the letter is only a fallback now.
  if (isRenderableAvatar(user?.avatar)) {
    paintAvatar(
      avatarLarge,
      resolveServerUrl(user.avatar),
      username,
      avatarInitial({ username, displayName: user?.display_name ?? null }),
    );
  }
  // Avatar, display name and about lead the editor; the username row follows.
  editor.prepend(
    buildAvatarUploader(options, avatarLarge, signal),
    buildProfileFields(
      options,
      (name) => {
        setText(headerName, name);
      },
      signal,
    ),
  );

  // Inline edit form
  const editForm = createElement("div", {
    class: "setting-row",
    style: "display:none;margin-bottom:16px",
  });
  const editInput = createElement("input", {
    class: "form-input",
    type: "text",
    placeholder: t("profile.newUsername"),
    "data-testid": "username-edit-input",
    "aria-label": t("profile.newUsername"),
    "aria-describedby": "username-edit-error",
  });
  const saveBtn = createElement("button", { class: "ac-btn secondary" }, t("common.save"));
  const cancelBtn = createElement("button", { class: "ac-btn secondary" }, t("recovery.cancel"));
  appendChildren(editForm, editInput, saveBtn, cancelBtn);

  const usernameError = outcomeEl("error");
  usernameError.id = "username-edit-error";
  usernameError.style.marginTop = "4px";
  editForm.appendChild(usernameError);

  const openEditForm = () => {
    editForm.style.display = "flex";
    editInput.value = authStore.getState().user?.username ?? "";
    editInput.focus();
  };
  const closeEditForm = () => {
    editForm.style.display = "none";
    setText(usernameError, "");
    if (focusIsOurs(editForm)) editUsernameBtn.focus();
  };

  editUsernameBtn.addEventListener("click", openEditForm, { signal });

  cancelBtn.addEventListener("click", closeEditForm, { signal });

  saveBtn.addEventListener(
    "click",
    () => {
      const newName = editInput.value.trim();
      if (newName.length < 2 || newName.length > MAX_USERNAME_LEN) {
        setText(usernameError, t("profile.usernameInvalid", { max: MAX_USERNAME_LEN }));
        return;
      }
      setText(usernameError, "");
      void options
        .onUpdateProfile({ username: newName })
        .then(() => {
          // The header shows the resolved display name, not the raw
          // username — mirror buildProfileFields' onSaved callback so the
          // two writers of `.account-header-name` agree (OC-0188). The
          // store is already updated by the time this resolves, so read it
          // fresh rather than assuming the username *is* the display name.
          setText(
            headerName,
            resolveDisplayName({
              username: newName,
              displayName: authStore.getState().user?.display_name ?? null,
            }),
          );
          setText(usernameValue, newName);
          setText(headerHandle, t("profile.handle", { username: newName }));
          closeEditForm();
        })
        .catch((err: unknown) => {
          setText(usernameError, errorText(err, t("profile.usernameSaveFailed")));
        });
    },
    { signal },
  );

  editor.appendChild(editForm);

  // Security state first, then status, retention and the danger zone.
  section.appendChild(buildSecurityCard(options, signal));
  section.appendChild(buildStatusSelector(options, signal));

  const retention = options.getRetentionNotice?.() ?? null;
  if (retention !== null) section.appendChild(buildRetentionSection(retention));

  // Delete account (danger zone)
  section.appendChild(buildDeleteAccountSection(options, signal));

  return section;
}
