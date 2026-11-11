/** Account tab device rows: one signed-in session and the API tokens block. */

import { createElement, appendChildren } from "@lib/dom";
import { errorText, ApiClientError } from "@lib/api";
import type { OwnApiToken, SessionInfo } from "@lib/api";
import { showToast } from "@lib/ui/toast";
import { sessionDeviceLabel } from "@lib/net/sessionNotice";
import { formatMessageTimestamp } from "@lib/text/formatting";
import { uiStore } from "@stores/ui.store";
import type { SettingsOverlayOptions } from "./SettingsOverlay";
import { accountText as t } from "../../i18n/account";
import { createLogger } from "@lib/logger";

const log = createLogger("AccountTab");

export function buildSessionRow(
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

// ---------------------------------------------------------------------------
// API tokens builder
// ---------------------------------------------------------------------------

function buildApiTokenRow(
  tok: OwnApiToken,
  revoke: (id: number) => Promise<void>,
  signal: AbortSignal,
  onListChanged: () => void,
  onRevoked: () => void,
): HTMLDivElement {
  const row = createElement("div", {
    class: "session-row",
    "data-testid": "api-token-row",
    "data-token-id": String(tok.id),
  });
  const info = createElement("div", { class: "session-info" });
  appendChildren(
    info,
    createElement("div", { class: "session-device" }, tok.label),
    createElement(
      "div",
      { class: "session-detail" },
      t("apiTokens.detail", {
        created: formatMessageTimestamp(tok.created_at),
        used:
          tok.last_used === null ? t("apiTokens.neverUsed") : formatMessageTimestamp(tok.last_used),
      }),
    ),
  );
  const revokeBtn = createElement(
    "button",
    { class: "ac-btn secondary", "data-testid": "api-token-revoke" },
    t("apiTokens.revoke"),
  );
  revokeBtn.addEventListener(
    "click",
    () => {
      const list = row.parentElement;
      const next = row.nextSibling;
      row.remove();
      onListChanged();
      void revoke(tok.id)
        .then(() => {
          showToast(t("apiTokens.revoked"), "success");
          onRevoked();
        })
        .catch((err: unknown) => {
          // 404: already revoked or expired elsewhere, so the row stays gone.
          if (err instanceof ApiClientError && err.status === 404) {
            onRevoked();
            return;
          }
          if (next?.parentNode === list) list?.insertBefore(row, next);
          else list?.appendChild(row);
          onListChanged();
          showToast(errorText(err, t("apiTokens.revokeFailed")), "error");
        });
    },
    { signal },
  );
  appendChildren(row, info, revokeBtn);
  return row;
}

/** The account's API tokens with a revoke button each. Stays hidden while the
 *  account has none, and when the list cannot be read. Reloads on a `change`
 *  from `tokensChanged` and sends one after each revoke, so the password
 *  form's option stays in step. */
export function buildApiTokensBlock(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
  tokensChanged?: EventTarget,
): HTMLDivElement | null {
  const listTokens = options.onListApiTokens;
  const revoke = options.onRevokeApiToken;
  if (listTokens === undefined || revoke === undefined) return null;
  const block = createElement("div", { "data-testid": "api-tokens-section" });
  block.hidden = true;
  const list = createElement("div", { class: "session-list", "data-testid": "api-tokens-list" });
  appendChildren(
    block,
    createElement("div", { class: "settings-section-title" }, t("apiTokens.title")),
    createElement("div", { class: "setting-desc" }, t("apiTokens.description")),
    list,
  );
  const sync = (): void => {
    block.hidden = list.childElementCount === 0;
  };
  // A revoke here announces the change; the listener below skips that echo.
  let announcing = false;
  const announce = (): void => {
    announcing = true;
    tokensChanged?.dispatchEvent(new Event("change"));
    announcing = false;
  };
  let loadGen = 0;
  const load = (): void => {
    const gen = ++loadGen;
    void listTokens()
      .then((tokens) => {
        if (signal.aborted || gen !== loadGen) return;
        list.replaceChildren(
          ...tokens.map((tok) => buildApiTokenRow(tok, revoke, signal, sync, announce)),
        );
        sync();
      })
      .catch((err: unknown) => {
        if (signal.aborted || gen !== loadGen) return;
        log.warn("Failed to list API tokens", err);
      });
  };
  load();
  tokensChanged?.addEventListener(
    "change",
    () => {
      if (!announcing) load();
    },
    { signal },
  );
  return block;
}
