/**
 * Builds the login form's DOM: the form panel and its field groups, the two-
 * factor and auto-connect overlays, and the server-wait and busy-retry lines.
 */
import { createElement, appendChildren, qs } from "@lib/dom";
import { isImeCommit } from "@lib/text/ime";
import { createIcon } from "@lib/icons";
import { setAddressInputHints } from "@lib/net/hostNormalize";
import { connectText } from "../../../i18n/connect";
import { portalText } from "../../../i18n/portal";
import { attachLimitHint, usernameHintText, MAX_USERNAME_LEN } from "@lib/text/nameLimits";
import { SAVED_PASSWORD_PLACEHOLDER } from "./loginShared";
import type { LoginFormState, LoginFormInternals } from "./loginState";

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

    // Logo section — OC neon glow SVG
    const formLogo = createElement("div", { class: "form-logo" });
    const logoSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    logoSvg.setAttribute("width", "70");
    logoSvg.setAttribute("height", "42");
    logoSvg.setAttribute("viewBox", "0 0 120 70");
    logoSvg.setAttribute("class", "oc-logo");
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const grad = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
    grad.setAttribute("id", "oc-grad-form");
    grad.setAttribute("x1", "0%");
    grad.setAttribute("y1", "0%");
    grad.setAttribute("x2", "100%");
    grad.setAttribute("y2", "0%");
    for (const [offset, color] of [
      ["0%", "#f97316"],
      ["30%", "#ec4899"],
      ["65%", "#8b5cf6"],
      ["100%", "#06b6d4"],
    ] as const) {
      const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
      stop.setAttribute("offset", offset);
      stop.setAttribute("style", `stop-color:${color}`);
      grad.appendChild(stop);
    }
    const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    filter.setAttribute("id", "oc-glow-form");
    const blur = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
    blur.setAttribute("stdDeviation", "4");
    blur.setAttribute("result", "blur");
    filter.appendChild(blur);
    const comp = document.createElementNS("http://www.w3.org/2000/svg", "feComposite");
    comp.setAttribute("in", "SourceGraphic");
    comp.setAttribute("in2", "blur");
    comp.setAttribute("operator", "over");
    filter.appendChild(comp);
    defs.appendChild(grad);
    defs.appendChild(filter);
    logoSvg.appendChild(defs);
    for (const [opacity, filterAttr] of [
      ["0.4", "url(#oc-glow-form)"],
      [null, null],
    ] as const) {
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("x", "60");
      t.setAttribute("y", "56");
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("font-family", "'Segoe UI',system-ui,sans-serif");
      t.setAttribute("font-size", "68");
      t.setAttribute("font-weight", "900");
      t.setAttribute("fill", "url(#oc-grad-form)");
      t.setAttribute("letter-spacing", "-4");
      if (opacity) {
        t.setAttribute("opacity", opacity);
        t.setAttribute("class", "oc-glow-layer");
      }
      if (filterAttr) t.setAttribute("filter", filterAttr);
      t.textContent = "OC"; // i18n-exempt: logo monogram, not copy
      logoSvg.appendChild(t);
    }
    // i18n-exempt: product name, never translated
    const logoTitle = createElement("h1", {}, "OwnCord");
    const logoSubtitle = createElement("p", {}, connectText("login.subtitle"));
    appendChildren(formLogo, logoSvg, logoTitle, logoSubtitle);

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
    const rememberLabel = createElement(
      "label",
      {
        for: "remember-password",
        class: "remember-password-label",
      },
      connectText("login.rememberPassword"),
    );
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
          class: "totp-backup-link",
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

  function buildTotpOverlay(): HTMLDivElement {
    const overlay = createElement("div", { class: "totp-overlay totp-overlay--hidden" });
    const card = createElement("div", { class: "totp-card" });
    const title = createElement("h2", { class: "totp-title" }, connectText("totp.title"));
    const description = createElement(
      "p",
      {
        class: "totp-subtitle",
      },
      connectText("totp.description"),
    );

    // Not numeric-only: an emergency recovery code is letters and digits,
    // 11 characters with its separator, and goes in this same box.
    st.totpInput = createElement("input", {
      class: "form-input",
      type: "text",
      maxlength: "11",
      placeholder: connectText("totp.placeholder"),
      inputmode: "text",
      pattern: "[0-9]{6}|[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}",
      autocomplete: "one-time-code",
      "aria-label": connectText("totp.inputLabel"),
      "aria-describedby": "totp-error",
    });
    // A malformed code used to be a 500 ms red border with no text and no
    // announcement, so a screen reader got nothing. The message is the
    // input's description and focus returns to the input, so it is read once
    // with the field; it is a live alert only when the input already has
    // focus and so is not re-read.
    st.totpError = createElement("div", {
      class: "form-error",
      id: "totp-error",
      "data-testid": "totp-invalid",
    });

    st.totpSubmitBtn = createElement(
      "button",
      {
        class: "btn-primary",
        type: "button",
      },
      connectText("totp.verify"),
    );

    const cancelBtn = createElement(
      "button",
      {
        class: "totp-back",
        type: "button",
      },
      connectText("common.cancel"),
    );

    st.totpSubmitBtn.addEventListener("click", lf.handleTotpSubmit, { signal: st.signal });
    cancelBtn.addEventListener("click", lf.handleTotpCancel, { signal: st.signal });

    // Allow Enter key in TOTP input
    st.totpInput.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Enter" && !isImeCommit(e)) {
          e.preventDefault();
          void lf.handleTotpSubmit();
        }
      },
      { signal: st.signal },
    );

    appendChildren(
      card,
      title,
      description,
      st.totpInput,
      st.totpError,
      st.totpSubmitBtn,
      cancelBtn,
    );
    overlay.appendChild(card);
    return overlay;
  }

  function buildAutoConnectOverlay(): HTMLDivElement {
    const overlay = createElement("div", {
      class: "auto-connect-overlay auto-connect-overlay--hidden",
    });
    const card = createElement("div", { class: "auto-connect-card" });

    const spinner = createElement("div", { class: "auto-connect-spinner" });
    const spinnerEl = createElement("div", { class: "spinner" });
    spinner.appendChild(spinnerEl);

    const title = createElement(
      "h2",
      { class: "auto-connect-title" },
      connectText("login.autoConnecting"),
    );
    st.autoConnectServerName = createElement("span", { class: "auto-connect-server" });

    const cancelBtn = createElement(
      "button",
      {
        class: "btn-ghost auto-connect-cancel",
        type: "button",
      },
      connectText("common.cancel"),
    );

    cancelBtn.addEventListener(
      "click",
      () => {
        lf.transitionTo("idle");
        st.onAutoLoginCancel?.();
      },
      { signal: st.signal },
    );

    appendChildren(card, spinner, title, st.autoConnectServerName, cancelBtn);
    overlay.appendChild(card);
    return overlay;
  }

  function buildServerWait(): HTMLDivElement {
    // A live status line, not a modal: the form beneath stays usable.
    const wait = createElement("div", { class: "server-wait", role: "status" });
    wait.hidden = true;
    st.serverWaitText = createElement("span", { class: "server-wait-text" });
    const cancelBtn = createElement(
      "button",
      { class: "btn-ghost server-wait-cancel", type: "button" },
      connectText("common.cancel"),
    );
    cancelBtn.addEventListener("click", lf.cancelServerWait, { signal: st.signal });
    appendChildren(wait, st.serverWaitText, cancelBtn);
    return wait;
  }

  function buildAuthBusyRetry(): HTMLDivElement {
    // The server-wait line's look: a live status while a busy login retries.
    const line = createElement("div", { class: "server-wait auth-busy-retry", role: "status" });
    line.hidden = true;
    const text = createElement(
      "span",
      { class: "server-wait-text" },
      connectText("login.serverBusyRetrying"),
    );
    const cancelBtn = createElement(
      "button",
      { class: "btn-ghost server-wait-cancel", type: "button" },
      connectText("common.cancel"),
    );
    cancelBtn.addEventListener("click", () => st.cancelAuthBusyRetry?.(), { signal: st.signal });
    appendChildren(line, text, cancelBtn);
    return line;
  }

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
