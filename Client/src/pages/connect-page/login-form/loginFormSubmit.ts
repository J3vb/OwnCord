/**
 * What the login form does on submit: mode toggle, validation, sign-in with the
 * busy-server retry, the two-factor step and account recovery.
 */
import { setText, setOwnedTimeout, focusIsOurs } from "@lib/dom";
import { ApiClientError, TLS_CERT_CODE, TransportError, errorText } from "@lib/api";
import { isValidHost } from "@lib/net/hostValidation";
import { normaliseInviteCode } from "@lib/nav/deepLink";
import { connectText } from "../../../i18n/connect";
import { checkNewUsername, usernameProblemText } from "@lib/text/nameLimits";
import { RestErrorCode } from "@lib/protocolTypes";
import {
  FieldId,
  MIN_PASSWORD_LENGTH,
  SAVED_PASSWORD_PLACEHOLDER,
  TOTP_OR_RECOVERY_CODE,
  AUTH_BUSY_RETRY_BUDGET_MS,
  AUTH_BUSY_MIN_RETRY_MS,
  AUTH_BUSY_JITTER_MS,
  isAuthBusy,
} from "./loginShared";
import type { LoginFormState, LoginFormInternals } from "./loginState";

export function createLoginFormSubmit(st: LoginFormState, lf: LoginFormInternals) {
  function handleToggleMode(): void {
    st.cancelAuthBusyRetry?.();
    st.formMode = st.formMode === "login" ? "register" : "login";
    lf.applyUsernameRules();

    // A remembered password belongs to an EXISTING account. Carrying the
    // placeholder into Register would submit a fixed, publicly known constant
    // as the new account's password, because only the login branch consults
    // `usingSavedPassword`.
    lf.clearSavedPasswordPlaceholder();

    const title = connectText(st.formMode === "login" ? "login.title" : "login.registerTitle");
    setText(st.formTitle, title);
    setText(st.submitBtnText, title);
    setText(
      st.toggleModeBtn,
      connectText(st.formMode === "login" ? "login.toRegister" : "login.toLogin"),
    );

    // Password managers offer a generated password for a new account.
    st.passwordInput.setAttribute(
      "autocomplete",
      st.formMode === "login" ? "current-password" : "new-password",
    );

    lf.updateRegistrationUi();
    lf.scheduleHostSettled(0);

    // Clear any existing error
    if (st.formState === "error") {
      lf.transitionTo("idle");
    }
  }

  function validateForm(): {
    message: string;
    field: FieldId | null;
    /** The message is shown under the field (its hint); the banner points there. */
    inline?: boolean;
  } | null {
    const host = lf.currentHost();
    const username = st.usernameInput.value.trim();
    const password = st.passwordInput.value;

    if (!host) {
      return { message: connectText("validation.hostRequired"), field: "host" };
    }
    if (!isValidHost(host)) {
      return { message: connectText("validation.hostInvalid"), field: "host" };
    }
    if (!username) {
      return { message: connectText("validation.usernameRequired"), field: "username" };
    }
    // A new name is checked against the server's rules; Login sends whatever
    // the account was created with.
    if (st.formMode === "register") {
      const problem = checkNewUsername(username);
      if (problem !== null) {
        return { message: usernameProblemText(problem), field: "username", inline: true };
      }
    }
    // A saved password is already known-good; it is never re-validated here
    // because its plaintext is not available to this process. The bypass is
    // login-only: registration always needs a real, freshly typed password.
    if (!st.usingSavedPassword || st.formMode !== "login") {
      if (!password) {
        return { message: connectText("validation.passwordRequired"), field: "password" };
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        return {
          message: connectText("validation.passwordTooShort", { min: MIN_PASSWORD_LENGTH }),
          field: "password",
        };
      }
    }
    if (st.formMode === "register") {
      // The placeholder can re-enter the field as literal text (reveal it,
      // copy the bullets, paste them back — `beforeinput` clears the flag
      // before the paste lands), with nothing left marking it as anything
      // but ordinary text. Registration is the only place that turns that
      // text into a lasting, guessable credential, so it is the only place
      // it is refused — statelessly, because gating this on remembered
      // history (whether the field had shown the placeholder before) was
      // wrong in both directions.
      if (password === SAVED_PASSWORD_PLACEHOLDER) {
        return { message: connectText("validation.placeholderPassword"), field: "password" };
      }
      const mode = lf.currentRegistrationMode();
      if (mode === "closed") {
        // No field is at fault (and the invite field is hidden in this mode),
        // so the banner stands alone.
        return { message: connectText("registration.closedNotice"), field: null };
      }
      // `invite` and an unknown mode (older server / failed read) both require
      // a code. Never widen registration because the mode could not be read.
      if (mode === "invite" || mode === null) {
        const inviteCode = normaliseInviteCode(st.inviteInput.value);
        if (!inviteCode) {
          return { message: connectText("validation.inviteRequired"), field: "invite" };
        }
      }
    }
    return null;
  }

  /**
   * Run a login, retrying an AUTH_BUSY refusal after the larger of its
   * Retry-After and AUTH_BUSY_MIN_RETRY_MS (plus jitter) until it succeeds,
   * fails any other way, or that wait (before jitter) would overrun the retry budget —
   * that refusal is the one shown. The busy line shows while it retries; its
   * Cancel, or picking another host, sends no further attempt, reports
   * `onAutoLoginCancel` (which ends the attempt in flight) and returns the
   * form to idle.
   */
  async function loginRetryingWhileBusy(login: () => Promise<void>): Promise<void> {
    const deadline = Date.now() + AUTH_BUSY_RETRY_BUDGET_MS;
    let cancelled = false;
    let wake: (() => void) | null = null;
    st.cancelAuthBusyRetry = () => {
      cancelled = true;
      st.authBusyRetry.hidden = true;
      wake?.();
      st.onAutoLoginCancel?.();
    };
    try {
      for (;;) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- a retry is sequential by definition
          await login();
          return;
        } catch (err) {
          if (cancelled) {
            lf.transitionTo("idle");
            return;
          }
          if (!isAuthBusy(err)) throw err;
          const minWait = Math.max(err.retryAfterMs ?? 0, AUTH_BUSY_MIN_RETRY_MS);
          const left = deadline - Date.now();
          if (minWait > left) throw err;
          // Jitter never costs the last retry: it is clipped to the budget.
          const wait = Math.min(minWait + Math.random() * AUTH_BUSY_JITTER_MS, left);
          st.authBusyRetry.hidden = false;
          // oxlint-disable-next-line no-await-in-loop -- the wait between retries
          await new Promise<void>((resolve) => {
            wake = resolve;
            setOwnedTimeout(st.signal, resolve, wait);
          });
          if (cancelled) {
            lf.transitionTo("idle");
            return;
          }
        }
      }
    } finally {
      st.cancelAuthBusyRetry = null;
      st.authBusyRetry.hidden = true;
    }
  }

  async function handleFormSubmit(e: Event): Promise<void> {
    e.preventDefault();

    if (st.formState === "loading" || st.formState === "connecting") {
      return;
    }

    const validationError = validateForm();
    if (validationError !== null) {
      if (validationError.inline === true) {
        // Said once, under the field; the banner points at it.
        st.usernameHint.showError(validationError.message);
        lf.transitionTo("error", connectText("limits.checkField"), validationError.field);
        return;
      }
      lf.transitionTo("error", validationError.message, validationError.field);
      return;
    }

    const host = lf.currentHost();
    const username = st.usernameInput.value.trim();
    const password = st.passwordInput.value;
    // The mode toggle stays live while a request is in flight.
    const mode = st.formMode;

    st.certRefusedSubmit = null;
    lf.transitionTo("loading");

    try {
      if (mode === "login") {
        const savedPassword = st.usingSavedPassword;
        await loginRetryingWhileBusy(() =>
          savedPassword
            ? st.onLoginWithSavedPassword(host, username)
            : st.onLogin(host, username, password),
        );
      } else {
        const inviteCode = normaliseInviteCode(st.inviteInput.value);
        await st.onRegister(host, username, password, inviteCode);
      }
      // If the callback didn't throw, the caller handles navigation.
      // The caller may also call showTotp() or showError() on this page.
    } catch (err: unknown) {
      let message: string;
      if (err instanceof TransportError || err instanceof ApiClientError) {
        // A transport failure or server refusal: plain catalog copy for an
        // unreachable server or a known code, the capitalised server message
        // otherwise.
        message = errorText(err, connectText("error.serverFallback"));
      } else if (err instanceof Error) {
        message = err.message;
      } else if (typeof err === "string") {
        message = err;
      } else if (err !== null && typeof err === "object" && "message" in err) {
        message = String(err.message);
      } else {
        message = String(err);
      }
      // Cap length to prevent phishing via server-controlled error messages
      if (message.length > 200) {
        message = message.slice(0, 200) + "...";
      }
      // The server refused the name itself (a reserved name, a character the
      // client check does not mirror): say so under the field and keep what
      // was typed, so it can be edited rather than retyped.
      if (
        st.formMode === "register" &&
        err instanceof ApiClientError &&
        err.code === RestErrorCode.INVALID_INPUT &&
        /^username\b/i.test(err.message)
      ) {
        st.usernameHint.showError(message);
        lf.transitionTo("error", connectText("limits.checkField"), "username");
        return;
      }
      if (err instanceof ApiClientError && err.code === TLS_CERT_CODE) {
        st.certRefusedSubmit = { host, mode };
      }
      lf.transitionTo("error", message);
    }
  }

  async function handleTotpSubmit(): Promise<void> {
    // Re-entrancy guard: the click path is protected by the button's
    // disabled attribute, but the Enter-key listener on totpInput (below) is
    // not — key auto-repeat or a fast double-Enter during the verify round
    // trip would otherwise fire a second request with the same one-time code,
    // which the server 401s (codes are single-use) and paints a spurious
    // "invalid two-factor code" error over a login that already succeeded.
    // The disabled flag already brackets exactly the in-flight window, so
    // reusing it covers both paths with one check.
    if (st.totpSubmitBtn.disabled) return;

    const code = st.totpInput.value.trim();
    if (!TOTP_OR_RECOVERY_CODE.test(code)) {
      st.totpInput.classList.add("error");
      st.totpInput.setAttribute("aria-invalid", "true");
      if (document.activeElement === st.totpInput) st.totpError.setAttribute("role", "alert");
      else st.totpError.removeAttribute("role");
      setText(st.totpError, connectText("totp.invalidCode"));
      setOwnedTimeout(st.signal, () => st.totpInput.classList.remove("error"), 500);
      st.totpInput.focus();
      return;
    }
    st.totpInput.classList.remove("error");
    st.totpInput.removeAttribute("aria-invalid");
    setText(st.totpError, "");

    st.totpSubmitBtn.disabled = true;
    setText(st.totpSubmitBtn, connectText("totp.verifying"));

    try {
      await st.onTotpSubmit(code);
      // Verify succeeded — the challenge is resolved, so drop the latch.
      // Otherwise any later, unrelated error (e.g. the post-auth WS connect
      // failing) would hit the `formState === "error" && totpPending` branch
      // in updateTotpOverlay() and re-open this now-dead overlay, whose
      // partial token has already been consumed by main.ts.
      st.totpPending = false;
    } catch (err) {
      const message =
        err instanceof ApiClientError &&
        err.code === RestErrorCode.RATE_LIMITED &&
        err.message === "too many failed attempts, try again later"
          ? connectText("error.totpTooManyAttempts")
          : errorText(err, connectText("totp.failed"));
      lf.transitionTo("error", message);
    } finally {
      st.totpSubmitBtn.disabled = false;
      setText(st.totpSubmitBtn, connectText("totp.verify"));
      if (st.totpPending && focusIsOurs(st.totpSubmitBtn)) st.totpSubmitBtn.focus();
    }
  }

  function handleTotpCancel(): void {
    st.totpPending = false;
    lf.transitionTo("idle");
  }

  function openRecover(): void {
    if (st.onRecover === undefined) return;
    if (st.formState === "loading" || st.formState === "connecting") return;
    st.recoverCtx ??= {
      signal: st.signal,
      anchor: st.totpOverlay,
      hostInput: st.hostInput,
      usernameInput: st.usernameInput,
      placeholder: SAVED_PASSWORD_PLACEHOLDER,
      onRecover: st.onRecover,
      onRecovered: () => lf.transitionTo("connecting"),
    };
    const ctx = st.recoverCtx;
    void import("../RecoverOverlay")
      .then((m) => m.openRecoverOverlay(ctx))
      .catch(() => lf.transitionTo("error", connectText("login.recoveryUnavailable")));
  }

  return {
    handleToggleMode,
    validateForm,
    loginRetryingWhileBusy,
    handleFormSubmit,
    handleTotpSubmit,
    handleTotpCancel,
    openRecover,
  };
}
