/**
 * Account settings tab — profile editing, password change.
 * Discord-style profile card with colored banner, overlapping avatar,
 * and separated field rows.
 */

import { createElement, appendChildren, setText, focusIsOurs } from "@lib/dom";
import { errorText } from "@lib/api";
import { authStore } from "@stores/auth.store";
import { resolveDisplayName, avatarInitial } from "@lib/ui/avatar";
import { isRenderableAvatar } from "../../features/profiles/avatar";
import { resolveServerUrl } from "../../features/messaging/content/attachments";
import { profileBannersEnabled } from "@lib/net/serverCapabilities";
import { paintBanner } from "../../features/profiles/banner";
import { bannerImages } from "../../features/profiles/bannerImages";
import type { SettingsOverlayOptions } from "../SettingsOverlay";
import { buildRecoveryKitSection } from "./RecoverySections";
import { outcomeEl } from "./helpers";
import { statusIcon, type StatusKind, setStatusIcon } from "../../features/settings/status";
import { accountText as t } from "../../i18n/account";
import {
  attachLimitHint,
  MAX_USERNAME_LEN,
  usernameHintText,
  checkNewUsername,
  usernameProblemText,
} from "@lib/text/nameLimits";
import { buildPasswordSection, buildTotpSection } from "./AccountSecurity";
import {
  buildDeleteAccountSection,
  buildRetentionSection,
  buildSessionsSection,
  buildStatusSelector,
} from "./AccountSessions";
import {
  type BannerEditor,
  buildAvatarUploader,
  buildBannerEditor,
  buildProfileCard,
  buildProfileFields,
  paintAvatar,
} from "./AccountProfile";
export { validateAvatarFile, prepareBannerFile } from "./AccountProfile";

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
  const {
    card,
    banner,
    headerName,
    headerHandle,
    usernameValue,
    editUsernameBtn,
    avatarLarge,
    editor,
  } = buildProfileCard(displayName, username, signal);
  section.appendChild(card);

  // The strip follows the stored banner, and the colour being edited while the
  // editor is open (an unsaved choice previews, as the avatar does).
  let bannerEditor: BannerEditor | null = null;
  const paintStrip = (): void => {
    const u = authStore.getState().user;
    paintBanner(
      banner,
      {
        banner: u?.banner ?? null,
        banner_color: bannerEditor === null ? (u?.banner_color ?? null) : bannerEditor.current(),
      },
      card,
      bannerImages,
    );
  };
  if (profileBannersEnabled()) bannerEditor = buildBannerEditor(options, paintStrip, signal);
  paintStrip();
  const unsubStrip = authStore.subscribeSelector(
    (st) => `${st.user?.banner ?? ""}|${st.user?.banner_color ?? ""}`,
    paintStrip,
  );
  signal.addEventListener("abort", () => unsubStrip?.(), { once: true });

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
    ...(bannerEditor === null ? [] : [bannerEditor.el]),
    buildProfileFields(
      options,
      (name) => {
        setText(headerName, name);
      },
      signal,
      bannerEditor,
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
  const usernameHint = attachLimitHint(editInput, {
    max: MAX_USERNAME_LEN,
    countCharacters: true,
    hint: usernameHintText(),
    id: "username-edit-hint",
    signal,
  });
  const saveBtn = createElement("button", { class: "ac-btn secondary" }, t("common.save"));
  const cancelBtn = createElement("button", { class: "ac-btn secondary" }, t("recovery.cancel"));
  appendChildren(editForm, editInput, saveBtn, cancelBtn);

  const usernameError = outcomeEl("error");
  usernameError.id = "username-edit-error";
  usernameError.style.marginTop = "4px";
  editForm.style.flexWrap = "wrap";
  usernameError.style.width = "100%";
  usernameHint.el.style.width = "100%";
  editForm.append(usernameError, usernameHint.el);

  const openEditForm = () => {
    editForm.style.display = "flex";
    editInput.value = authStore.getState().user?.username ?? "";
    usernameHint.reset();
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
      // Resending the name the account already has is checked by the server's
      // loose rule (an older account may not meet the new one); a different
      // name is a rename and must pass the new-name rules.
      const problem =
        newName === authStore.getState().user?.username ? null : checkNewUsername(newName);
      if (problem !== null) {
        editInput.setAttribute("aria-invalid", "true");
        setText(usernameError, usernameProblemText(problem));
        return;
      }
      editInput.removeAttribute("aria-invalid");
      setText(usernameError, "");
      void options
        .onUpdateProfile({ username: newName })
        .then(() => {
          // The header shows the resolved display name, not the raw
          // username — mirror buildProfileFields' onSaved callback so the
          // two writers of `.account-header-name` agree. The
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
          // The server's own refusal text, under the field; the typed name stays.
          editInput.setAttribute("aria-invalid", "true");
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
