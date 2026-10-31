/** Account tab: status selector, signed-in sessions, data retention and account deletion. */

import { createElement, appendChildren, setText, focusIsOurs } from "@lib/dom";
import type { UserStatus } from "@lib/types";
import { errorText } from "@lib/api";
import type { SessionInfo } from "@lib/api";
import { showToast } from "@lib/ui/toast";
import { sessionDeviceLabel } from "@lib/net/sessionNotice";
import { formatMessageTimestamp } from "@lib/text/formatting";
import { uiStore } from "@stores/ui.store";
import { loadUserStatus, saveUserStatus } from "@lib/presence/userStatus";
import type { SettingsOverlayOptions } from "./SettingsOverlay";
import { platformText, outcomeEl } from "./helpers";
import { createStatusRow, createRevealToggle, setStatusIcon, createDisclosure } from "./status";
import { accountText as t } from "../../i18n/account";
import { createLogger } from "@lib/logger";

const log = createLogger("AccountTab");

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
export function buildStatusSelector(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const wrapper = createElement("div", {});
  const row = createElement("div", { class: "setting-row" });
  const info = createElement("div", {});
  appendChildren(
    info,
    createElement("label", { class: "setting-label", for: "status-select" }, t("status.showMeAs")),
    createElement(
      "div",
      { class: "setting-desc" },
      platformText(t("status.hint"), t("status.hint.android")),
    ),
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

export function buildSessionsSection(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
): HTMLLIElement {
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
// Message retention
// ---------------------------------------------------------------------------

/** The server-default retention window, when the server reported one. */
export function buildRetentionSection(notice: string): HTMLDivElement {
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

export function buildDeleteAccountSection(
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
    // No retention window here. Erasure hard-deletes
    // the account's messages and attachments at once (Server/db/erasure.go),
    // so a "kept N days" line would imply a grace period that does not exist.
    t("delete.warning"),
  );

  const passwordLabel = createElement(
    "label",
    { class: "form-label", for: "delete-account-password" },
    // Same text as the placeholder, so the field's accessible name is
    // unchanged by gaining a real <label>.
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
