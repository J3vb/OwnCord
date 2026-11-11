/**
 * Builds the login form's overlays and status lines: the two-factor card, the
 * auto-connect card, the server-wait line and the busy-retry line. Each takes
 * the slice of the form's state it writes or reads, and the handlers it wires.
 */
import { createElement, appendChildren } from "@lib/dom";
import { isImeCommit } from "@lib/text/ime";
import { connectText } from "../../i18n/connect";

export interface TotpOverlayState {
  readonly signal: AbortSignal;
  totpInput: HTMLInputElement;
  totpError: HTMLDivElement;
  totpSubmitBtn: HTMLButtonElement;
}

export interface TotpOverlayHandlers {
  handleTotpSubmit(): Promise<void>;
  handleTotpCancel(): void;
}

export interface AutoConnectOverlayState {
  readonly signal: AbortSignal;
  autoConnectServerName: HTMLSpanElement;
  readonly onAutoLoginCancel: (() => void) | undefined;
}

export interface AutoConnectOverlayHandlers {
  transitionTo(state: "idle"): void;
}

export interface ServerWaitState {
  readonly signal: AbortSignal;
  serverWaitText: HTMLSpanElement;
}

export interface ServerWaitHandlers {
  cancelServerWait(): void;
}

export interface AuthBusyRetryState {
  readonly signal: AbortSignal;
  cancelAuthBusyRetry: (() => void) | null;
}

export function buildTotpOverlay(st: TotpOverlayState, lf: TotpOverlayHandlers): HTMLDivElement {
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

  appendChildren(card, title, description, st.totpInput, st.totpError, st.totpSubmitBtn, cancelBtn);
  overlay.appendChild(card);
  return overlay;
}

export function buildAutoConnectOverlay(
  st: AutoConnectOverlayState,
  lf: AutoConnectOverlayHandlers,
): HTMLDivElement {
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

export function buildServerWait(st: ServerWaitState, lf: ServerWaitHandlers): HTMLDivElement {
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

export function buildAuthBusyRetry(st: AuthBusyRetryState): HTMLDivElement {
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
