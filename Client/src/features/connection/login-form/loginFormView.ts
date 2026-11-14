/**
 * Keeps the login form's DOM in step with its state: state transitions, the
 * submit button, error and info banners, the status bar, overlays, registration
 * mode and the host field.
 */
import { setText, setOwnedTimeout, focusIsOurs } from "@lib/dom";
import { canonicalServerHost } from "@lib/net/hostNormalize";
import type { RegistrationMode } from "@lib/types";
import { connectText } from "../../../i18n/connect";
import { toggleDescribedBy } from "@lib/text/nameLimits";
import { FieldId, registrationNoticeText, isBusy } from "./loginShared";
import type { LoginFormState, LoginFormInternals } from "./loginState";
import type { FormState } from "../LoginForm";

export function createLoginFormView(st: LoginFormState, lf: LoginFormInternals) {
  function cancelServerWait(): void {
    if (st.serverWait.hidden) return;
    st.serverWait.hidden = true;
    st.onAutoLoginCancel?.();
  }

  // ---------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------

  function transitionTo(state: FormState, error?: string, field: FieldId | null = null): void {
    const wasBusy = isBusy(st.formState);
    const focused = document.activeElement;
    st.formState = state;
    st.errorMessage = error ?? "";
    // A validation error names its field; a server error names none. Kept on
    // the instance so the input keeps aria-invalid/aria-describedby while the
    // banner is up, through unrelated store updates.
    st.errorField = state === "error" ? field : null;
    // Any state change supersedes an informational notice: the user is trying
    // again (busy), a real error replaced it, or the form reset.
    st.noticeMessage = "";
    updateInfoNotice();

    // Update UI based on state
    updateSubmitButton();
    updateErrorBanner();
    updateStatusBar();
    updateTotpOverlay();
    updateAutoConnectOverlay();
    updateFormInputsDisabled();

    // Disabling the inputs drops a focused one to <body>; once the request
    // settles, put focus back where the user submitted from.
    if (!wasBusy && isBusy(state)) {
      st.focusBeforeBusy = focused;
    } else if (wasBusy && !isBusy(state)) {
      const restore = st.focusBeforeBusy;
      st.focusBeforeBusy = null;
      if (restore instanceof HTMLElement && restore !== document.body && focusIsOurs(restore)) {
        restore.focus();
      }
    }
  }

  /** The input a banner error for `field` belongs to. */
  function fieldInput(field: FieldId): HTMLInputElement {
    if (field === "host") return st.hostInput;
    if (field === "username") return st.usernameInput;
    if (field === "password") return st.passwordInput;
    return st.inviteInput;
  }

  function updateSubmitButton(): void {
    const isLoading = isBusy(st.formState);
    // A closed server refuses registration outright — disable the control and
    // let the notice state why, rather than collecting a doomed attempt.
    const refused = isRegisterRefused();
    st.submitBtn.disabled = isLoading || refused;
    st.submitBtn.classList.toggle("loading", isLoading);

    if (st.formState === "connecting" || st.formState === "auto-connecting") {
      setText(st.submitBtnText, connectText("login.connecting"));
    } else if (st.formState === "loading") {
      setText(
        st.submitBtnText,
        connectText(st.formMode === "login" ? "login.loggingIn" : "login.registering"),
      );
    } else if (refused) {
      setText(st.submitBtnText, connectText("login.registrationClosed"));
    } else {
      setText(
        st.submitBtnText,
        connectText(st.formMode === "login" ? "login.title" : "login.registerTitle"),
      );
    }
  }

  /** All inputs a banner error can be linked to. */
  function allFieldInputs(): HTMLInputElement[] {
    return [st.hostInput, st.usernameInput, st.passwordInput, st.inviteInput];
  }

  function updateErrorBanner(): void {
    // A field error is linked to its input and focus moves there, so a
    // keyboard/screen-reader user lands on the control to fix rather than on
    // an unassociated sentence. The banner is only a live alert when
    // focus does not move — a server error naming no field, or a field that
    // already has focus — so each error is announced once.
    const field = st.formState === "error" ? st.errorField : null;
    const target = field === null ? null : fieldInput(field);
    if (target === null || target === document.activeElement) {
      st.errorBanner.setAttribute("role", "alert");
    } else {
      st.errorBanner.removeAttribute("role");
    }
    for (const input of allFieldInputs()) {
      input.removeAttribute("aria-invalid");
      toggleDescribedBy(input, st.errorBanner.id, false);
    }
    if (st.formState === "error" && st.errorMessage) {
      setText(st.errorBanner, st.errorMessage);
      st.errorBanner.classList.add("visible");
      if (target !== null) {
        target.setAttribute("aria-invalid", "true");
        toggleDescribedBy(target, st.errorBanner.id, true);
        target.focus();
      }
      // The shakeX animation plays automatically via CSS on .error-banner
      // Re-trigger animation by removing and re-adding the element
      st.errorBanner.style.animation = "none";
      // Force reflow to restart animation
      void st.errorBanner.offsetWidth;
      st.errorBanner.style.animation = "";
    } else {
      st.errorBanner.classList.remove("visible");
    }
  }

  function updateInfoNotice(): void {
    if (st.noticeMessage) {
      setText(st.infoNotice, st.noticeMessage);
      st.infoNotice.classList.add("visible");
    } else {
      setText(st.infoNotice, "");
      st.infoNotice.classList.remove("visible");
    }
  }

  function updateStatusBar(): void {
    switch (st.formState) {
      case "idle":
      case "totp":
      case "error":
        st.statusBar.classList.remove("visible", "indeterminate");
        break;
      case "loading":
      case "connecting":
      case "auto-connecting":
        st.statusBar.classList.add("visible", "indeterminate");
        break;
    }
  }

  function updateTotpOverlay(): void {
    if (st.formState === "totp") {
      st.totpOverlay.classList.remove("totp-overlay--hidden");
      st.totpInput.value = "";
      st.totpInput.classList.remove("error");
      st.totpInput.removeAttribute("aria-invalid");
      setText(st.totpError, "");
      st.totpInput.focus();
    } else if (st.formState === "error" && st.totpPending) {
      // A rejected verify lands here — keep the overlay up (and the
      // already-entered code in place) instead of dropping the user back on
      // the login form with no way to retry. The banner is inside the form
      // panel, which the opaque overlay covers, so the rejection must also be
      // written to the in-overlay error node or the user sees nothing (F2).
      st.totpOverlay.classList.remove("totp-overlay--hidden");
      if (st.errorMessage) {
        setText(st.totpError, st.errorMessage);
        st.totpInput.classList.add("error");
        st.totpInput.setAttribute("aria-invalid", "true");
      }
    } else {
      st.totpOverlay.classList.add("totp-overlay--hidden");
    }
  }

  function updateAutoConnectOverlay(): void {
    if (st.formState === "auto-connecting") {
      st.autoConnectOverlay.classList.remove("auto-connect-overlay--hidden");
    } else {
      st.autoConnectOverlay.classList.add("auto-connect-overlay--hidden");
    }
  }

  function updateFormInputsDisabled(): void {
    const disable = isBusy(st.formState);
    st.hostInput.disabled = disable;
    st.usernameInput.disabled = disable;
    st.passwordInput.disabled = disable;
    st.inviteInput.disabled = disable;
  }

  // ---------------------------------------------------------------------------
  // Registration mode
  // ---------------------------------------------------------------------------

  /**
   * The live registration mode for the currently-typed host, or null when it
   * is unknown. Only `invite` and null require an invite code; unknown is
   * deliberately treated as invite-required, never as `open`.
   */
  function currentRegistrationMode(): RegistrationMode | null {
    const host = currentHost();
    if (!host) return null;
    return st.getRegistrationMode?.(host) ?? null;
  }

  function isRegisterRefused(): boolean {
    return st.formMode === "register" && currentRegistrationMode() === "closed";
  }

  /**
   * Bring the register affordances in line with the selected host's mode:
   * the invite field is shown only when a code is actually needed, the notice
   * states `closed`/`approval` up front, and `closed` disables the submit
   * control. Idempotent and cheap; call it whenever the mode may have changed
   * (host edit, mode toggle, a late server-info snapshot).
   */
  function updateRegistrationUi(): void {
    const registering = st.formMode === "register";
    const mode = registering ? currentRegistrationMode() : null;
    const requiresInvite = mode === "invite" || mode === null;

    st.inviteGroup.classList.toggle("form-group--hidden", !(registering && requiresInvite));

    // Where registration is possible, the server's retention window is part
    // of what the user signs up to, so it is disclosed here too.
    const host = currentHost();
    const retention =
      registering && mode !== "closed" && host ? (st.getRetentionNotice?.(host) ?? null) : null;
    const text =
      [registering ? registrationNoticeText(mode) : null, retention]
        .filter((part) => part !== null)
        .join(" ") || null;
    if (text !== null) {
      setText(st.registrationNotice, text);
      st.registrationNotice.classList.add("visible");
    } else {
      setText(st.registrationNotice, "");
      st.registrationNotice.classList.remove("visible");
    }

    updateSubmitButton();
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  /** The host box's address as the form saves and compares it. */
  function currentHost(): string {
    return canonicalServerHost(st.hostInput.value, st.getSavedHosts?.() ?? []);
  }

  /** Every write of the host goes through here: a new host ends the old one's busy retry and saved password. */
  function writeHost(host: string): void {
    if (host !== currentHost()) {
      st.cancelAuthBusyRetry?.();
      // The saved password belongs to the old host's stored credential.
      lf.clearSavedPasswordPlaceholder();
    }
    st.hostInput.value = host;
  }

  /** Register mode only: tell the owner which host the user settled on. */
  function scheduleHostSettled(delayMs = 500): void {
    const onHostSettled = st.onHostSettled;
    if (!onHostSettled || st.formMode !== "register") return;
    const seq = ++st.hostSettledSeq;
    const host = currentHost();
    if (!host) return;
    setOwnedTimeout(
      st.signal,
      () => {
        if (seq === st.hostSettledSeq && st.formMode === "register") onHostSettled(host);
      },
      delayMs,
    );
  }

  /** Register holds the username to the new-name rules; Login does not. */
  function applyUsernameRules(): void {
    const registering = st.formMode === "register";
    st.usernameHint.el.hidden = !registering;
    st.usernameHint.reset();
    // Login lifts the cap and the hint: nothing may describe the field by it.
    toggleDescribedBy(st.usernameInput, st.usernameHint.el.id, registering);
    if (registering) st.usernameInput.maxLength = st.usernameCap;
    else st.usernameInput.removeAttribute("maxlength");
  }

  return {
    cancelServerWait,
    transitionTo,
    fieldInput,
    updateSubmitButton,
    allFieldInputs,
    updateErrorBanner,
    updateInfoNotice,
    updateStatusBar,
    updateTotpOverlay,
    updateAutoConnectOverlay,
    updateFormInputsDisabled,
    currentRegistrationMode,
    isRegisterRefused,
    updateRegistrationUi,
    currentHost,
    writeHost,
    scheduleHostSettled,
    applyUsernameRules,
  };
}
