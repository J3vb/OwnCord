/**
 * Builds the login form's DOM: the form panel and its field groups, the two-
 * factor and auto-connect overlays, and the server-wait and busy-retry lines.
 */
import { createElement, appendChildren, qs } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { setAddressInputHints } from "@lib/net/hostNormalize";
import { isAndroidHost } from "@lib/hostPlatform";
import { connectText } from "../../../i18n/connect";
import { portalText } from "../../../i18n/portal";
import { attachLimitHint, usernameHintText, MAX_USERNAME_LEN } from "@lib/text/nameLimits";
import {
  buildTotpOverlay as buildTotpOverlayDom,
  buildAutoConnectOverlay as buildAutoConnectOverlayDom,
  buildServerWait as buildServerWaitDom,
  buildAuthBusyRetry as buildAuthBusyRetryDom,
} from "../../../features/connection/loginOverlays";
import { createOcLogo } from "../../../features/connection/ocLogo";
import { SAVED_PASSWORD_PLACEHOLDER } from "./loginShared";
import type { LoginFormState, LoginFormInternals } from "./loginState";

/** The logo block: the OC neon glow monogram, product name and subtitle. */
function buildFormLogo(): HTMLDivElement {
  const formLogo = createElement("div", { class: "form-logo" });
  const logoSvg = createOcLogo({ idSuffix: "-form", width: 70, height: 42 });
  // i18n-exempt: product name, never translated
  const logoTitle = createElement("h1", {}, "OwnCord");
  const logoSubtitle = createElement("p", {}, connectText("login.subtitle"));
  appendChildren(formLogo, logoSvg, logoTitle, logoSubtitle);
  return formLogo;
}

export function createLoginFormDom(st: LoginFormState, lf: LoginFormInternals) {
  /** Drop the placeholder the moment the user edits the field. */
  function clearSavedPasswordPlaceholder(): void {
    if (!st.usingSavedPassword) return;
    st.usingSavedPassword = false;
    // Only wipe the field if it still holds the placeholder. `beforeinput`
    // runs before the edit lands, so the field is still the placeholder
    // there and this clears it so the edit lands in an empty field. The
    // `input` backstop runs after a password manager has already replaced
    // the value with the real password it wants to submit — wiping that
    // unconditionally would blank a required field and block the login the
    // manager was trying to help with.
    if (st.passwordInput.value === SAVED_PASSWORD_PLACEHOLDER) {
      st.passwordInput.value = "";
    }
  }

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  function buildFormPanel(): HTMLDivElement {
    const panel = createElement("div", { class: "form-panel" });

    // Settings gear (top right)
    const settingsBtn = createElement("button", {
      class: "settings-gear",
      type: "button",
      "aria-label": connectText("common.settings"),
    });
    settingsBtn.textContent = "";
    settingsBtn.appendChild(createIcon("settings", 16));
    settingsBtn.addEventListener("click", () => st.onSettingsOpen(), { signal: st.signal });

    // Form container
    const formContainer = createElement("div", { class: "form-container" });

    const formLogo = buildFormLogo();

    // Form title
    st.formTitle = createElement("h1", {}, connectText("login.title"));

    // Error banner (hidden by default via CSS display:none, shown with .visible)
    st.errorBanner = createElement("div", {
      class: "error-banner",
      role: "alert",
      id: "connect-error-banner",
    });

    // Informational notice: a green/neutral status line for a fact the
    // user needs (pending approval), never the red error banner.
    st.infoNotice = createElement("div", { class: "info-notice", role: "status" });

    st.serverWait = buildServerWait();
    st.authBusyRetry = buildAuthBusyRetry();

    // Form
    const form = createElement("form", { class: "connect-form" });
    form.setAttribute("novalidate", "");

    // Host
    const hostGroup = buildFormGroup(
      "host",
      connectText("login.hostLabel"),
      "text",
      connectText("login.hostPlaceholder"),
    );
    st.hostInput = qs("input", hostGroup)!;
    if (__OWNCORD_WEB__ && st.fixedHost !== undefined) {
      st.hostInput.value = st.fixedHost;
      hostGroup.classList.add("form-group--hidden");
    }
    // Registration policy is per host, so a manually edited address re-derives
    // the mode (and the invite requirement) as the user types.
    st.hostInput.addEventListener(
      "input",
      () => {
        // A typed address is a different host, and the saved password is not its.
        clearSavedPasswordPlaceholder();
        lf.updateRegistrationUi();
        lf.scheduleHostSettled();
        st.onHostInput?.(lf.currentHost());
      },
      { signal: st.signal },
    );
    // Show the address the form will use once the user leaves the box.
    st.hostInput.addEventListener(
      "change",
      () => {
        const host = lf.currentHost();
        if (st.hostInput.value !== host) st.hostInput.value = host;
      },
      { signal: st.signal },
    );

    // Username
    const usernameGroup = buildFormGroup(
      "username",
      connectText("login.usernameLabel"),
      "text",
      "",
    );
    st.usernameInput = qs("input", usernameGroup)!;
    if (__OWNCORD_WEB__ && st.fixedHost !== undefined) {
      st.usernameInput.setAttribute("autocomplete", "username");
    }
    st.usernameHint = attachLimitHint(st.usernameInput, {
      max: MAX_USERNAME_LEN,
      countCharacters: true,
      hint: usernameHintText(),
      id: "username-hint",
      signal: st.signal,
    });
    st.usernameCap = st.usernameInput.maxLength;
    usernameGroup.appendChild(st.usernameHint.el);
    lf.applyUsernameRules();

    // Password
    const passwordGroup = buildFormGroup(
      "password",
      connectText("login.passwordLabel"),
      "password",
      "",
    );
    st.passwordInput = qs("input", passwordGroup)!;

    // Remember password checkbox
    const rememberGroup = createElement("div", { class: "form-group remember-password-group" });
    st.rememberPasswordCheckbox = createElement("input", {
      type: "checkbox",
      id: "remember-password",
    });
    // The phone shows one box, "Stay signed in", ticked by default: it keeps
    // this server's sign-in (and password) per server, so switching servers
    // does not sign the other one out. Auto connect follows it.
    const android = isAndroidHost();
    const rememberLabel = createElement(
      "label",
      {
        for: "remember-password",
        class: "remember-password-label",
      },
      connectText(android ? "login.staySignedIn" : "login.rememberPassword"),
    );
    if (android) {
      st.rememberPasswordCheckbox.checked = true;
      rememberLabel.classList.add("remember-password-label--stacked");
      appendChildren(
        rememberLabel,
        createElement(
          "span",
          { class: "remember-password-hint" },
          connectText("login.staySignedInHint"),
        ),
      );
    }
    appendChildren(rememberGroup, st.rememberPasswordCheckbox, rememberLabel);
    // The portal keeps no password: the token alone is kept, by Stay signed in.
    if (__OWNCORD_WEB__ && st.fixedHost !== undefined) {
      rememberGroup.classList.add("form-group--hidden");
    }

    // Auto connect checkbox
    const autoConnectGroup = createElement("div", { class: "form-group remember-password-group" });
    st.autoConnectCheckbox = createElement("input", { type: "checkbox", id: "auto-connect" });
    // Stay signed in by default; a saved profile overrides it.
    st.autoConnectCheckbox.checked = true;
    const autoConnectLabel = createElement(
      "label",
      {
        for: "auto-connect",
        class: "remember-password-label",
      },
      __OWNCORD_WEB__ && st.fixedHost !== undefined
        ? portalText("login.stayLoggedIn")
        : connectText("login.autoConnect"),
    );
    appendChildren(autoConnectGroup, st.autoConnectCheckbox, autoConnectLabel);
    if (android) autoConnectGroup.classList.add("form-group--hidden");

    // `beforeinput` fires for every actual edit — typing, paste, drag-drop —
    // and only for edits, so caret movement leaves the placeholder alone. It
    // runs before the value changes, so clearing there means the edit lands in
    // an empty field instead of mixing with the placeholder.
    //
    // `input` is the backstop: a password manager can replace the value and
    // emit only `input`, and leaving the flag set there would submit the stored
    // password while the field shows the one the manager just filled in. It is
    // a no-op after `beforeinput` has already cleared the flag, so it cannot
    // swallow a typed character.
    st.passwordInput.addEventListener("beforeinput", clearSavedPasswordPlaceholder, {
      signal: st.signal,
    });
    st.passwordInput.addEventListener("input", clearSavedPasswordPlaceholder, {
      signal: st.signal,
    });

    // Invite code (register only, hidden by default)
    st.inviteGroup = buildFormGroup("invite", connectText("login.inviteLabel"), "text", "");
    st.inviteGroup.classList.add("form-group--hidden");
    st.inviteInput = qs("input", st.inviteGroup)!;

    // Registration notice (register only): states the server's policy up
    // front for `closed` (why register is refused) and `approval` (the
    // pending-approval state, shown before the attempt rather than only after
    // a 202). Hidden by default.
    st.registrationNotice = createElement("div", {
      class: "registration-notice",
      role: "status",
    });

    // Submit button
    st.submitBtn = createElement("button", {
      class: "btn-primary",
      type: "submit",
    });
    st.submitBtnText = createElement("span", { class: "btn-text" }, connectText("login.title"));
    const spinnerWrapper = createElement("span", { class: "btn-spinner" });
    const spinner = createElement("div", { class: "spinner" });
    spinnerWrapper.appendChild(spinner);
    appendChildren(st.submitBtn, spinnerWrapper, st.submitBtnText);

    // Toggle mode link
    const formSwitch = createElement("div", { class: "form-switch" });
    // Buttons, not anchors: an <a> with no href is not focusable, so the
    // login/register toggle and the recovery entry point would be unreachable
    // by Tab (A11Y-02). They are styled as links by .form-switch button /
    // .totp-backup-link.
    st.toggleModeBtn = createElement("button", { type: "button" }, connectText("login.toRegister"));
    formSwitch.appendChild(st.toggleModeBtn);
    // Outside .form-switch: that button is the login/register toggle.
    let recoverLink: HTMLButtonElement | null = null;
    if (st.onRecover !== undefined) {
      recoverLink = createElement(
        "button",
        {
          type: "button",
          class: "totp-backup-link form-recover-link",
          "data-testid": "recover-account-link",
        },
        connectText("login.recoverLink"),
      );
      recoverLink.addEventListener("click", lf.openRecover, { signal: st.signal });
    }

    appendChildren(
      form,
      hostGroup,
      usernameGroup,
      passwordGroup,
      rememberGroup,
      autoConnectGroup,
      st.registrationNotice,
      st.inviteGroup,
      st.submitBtn,
      formSwitch,
      ...(recoverLink ? [recoverLink] : []),
    );

    // Wire form events
    form.addEventListener("submit", lf.handleFormSubmit, { signal: st.signal });
    // An edit after a certificate refusal is a new sign-in the user has not
    // sent yet, so accepting the certificate must not send it for them.
    form.addEventListener(
      "input",
      () => {
        st.certRefusedSubmit = null;
      },
      { signal: st.signal },
    );
    // Typing means the user is taking over from the automatic retry.
    for (const input of [st.hostInput, st.usernameInput, st.passwordInput]) {
      input.addEventListener("input", lf.cancelServerWait, { signal: st.signal });
    }
    st.toggleModeBtn.addEventListener("click", lf.handleToggleMode, { signal: st.signal });

    appendChildren(
      formContainer,
      formLogo,
      st.errorBanner,
      st.infoNotice,
      st.serverWait,
      st.authBusyRetry,
      form,
    );
    appendChildren(panel, settingsBtn, formContainer);
    return panel;
  }

  function buildFormGroup(
    id: string,
    labelText: string,
    inputType: string,
    placeholder: string,
  ): HTMLDivElement {
    const group = createElement("div", { class: "form-group" });
    const label = createElement("label", { class: "form-label", for: id }, labelText);
    const input = createElement("input", {
      class: "form-input",
      id,
      name: id,
      type: inputType,
      placeholder,
      autocomplete: inputType === "password" ? "current-password" : "off",
    });
    if (id === "host") {
      input.setAttribute("required", "");
      setAddressInputHints(input);
    }
    if (id === "username" || id === "password") {
      input.setAttribute("required", "");
    }
    // Phone keyboards would capitalise or correct a name or code.
    if (id === "username" || id === "invite") {
      input.setAttribute("autocapitalize", "none");
      input.setAttribute("autocorrect", "off");
      input.setAttribute("spellcheck", "false");
    }

    if (inputType === "password") {
      const wrapper = createElement("div", { class: "password-wrapper" });
      const toggle = createElement("button", {
        class: "password-toggle",
        type: "button",
        "aria-label": connectText("login.togglePassword"),
      });
      toggle.appendChild(createIcon("eye", 16));
      toggle.addEventListener(
        "click",
        () => {
          const isPassword = input.getAttribute("type") === "password";
          input.setAttribute("type", isPassword ? "text" : "password");
          toggle.textContent = "";
          toggle.appendChild(createIcon(isPassword ? "eye-off" : "eye", 16));
        },
        { signal: st.signal },
      );
      appendChildren(wrapper, input, toggle);
      appendChildren(group, label, wrapper);
    } else {
      appendChildren(group, label, input);
    }

    return group;
  }

  const buildTotpOverlay = (): HTMLDivElement => buildTotpOverlayDom(st, lf);
  const buildAutoConnectOverlay = (): HTMLDivElement => buildAutoConnectOverlayDom(st, lf);
  const buildServerWait = (): HTMLDivElement => buildServerWaitDom(st, lf);
  const buildAuthBusyRetry = (): HTMLDivElement => buildAuthBusyRetryDom(st);

  return {
    clearSavedPasswordPlaceholder,
    buildFormPanel,
    buildFormGroup,
    buildTotpOverlay,
    buildAutoConnectOverlay,
    buildServerWait,
    buildAuthBusyRetry,
  };
}
