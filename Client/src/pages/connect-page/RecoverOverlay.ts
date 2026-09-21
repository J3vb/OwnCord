// RecoverOverlay — account recovery for the connect page (B7-15b).
// Loaded on demand from LoginForm's recovery link, so it stays out of the
// startup bundle. The secret field takes a recovery kit secret or an
// owner-issued recovery credential; the server tells them apart by shape.

import { createElement, setText, appendChildren } from "@lib/dom";

const MIN_PASSWORD_LENGTH = 8;

/** What LoginForm hands over; one object per form, so it keys the cache. */
export interface RecoverContext {
  readonly signal: AbortSignal;
  /** The overlay is mounted right after this element (the 2FA overlay). */
  readonly anchor: Element;
  readonly hostInput: HTMLInputElement;
  /** Prefills the overlay; receives the username that recovered. */
  readonly usernameInput: HTMLInputElement;
  /** The saved-password placeholder, refused as a new password. */
  readonly placeholder: string;
  /** Recover and sign the returned session in; rejects with the reason. */
  readonly onRecover: (
    host: string,
    username: string,
    secret: string,
    newPassword: string,
  ) => Promise<void>;
  readonly onRecovered: () => void;
}

const overlays = new WeakMap<RecoverContext, (username: string) => void>();

/** Open the recovery overlay for a form, building and mounting it once. */
export function openRecoverOverlay(ctx: RecoverContext): void {
  let open = overlays.get(ctx);
  if (open === undefined) {
    open = createRecoverOverlay(ctx);
    overlays.set(ctx, open);
  }
  open(ctx.usernameInput.value.trim());
}

function buildField(
  id: string,
  labelText: string,
  type: string,
  autocomplete: string,
): { group: HTMLDivElement; input: HTMLInputElement } {
  const group = createElement("div", { class: "form-group" });
  const label = createElement("label", { class: "form-label", for: id }, labelText);
  const input = createElement("input", {
    class: "form-input",
    id,
    type,
    autocomplete,
    spellcheck: "false",
  });
  appendChildren(group, label, input);
  return { group, input };
}

function createRecoverOverlay(ctx: RecoverContext): (username: string) => void {
  const { signal } = ctx;
  const element = createElement("div", {
    class: "totp-overlay totp-overlay--hidden",
    "data-testid": "recover-overlay",
  });
  const card = createElement("div", { class: "totp-card" });
  const title = createElement("h2", { class: "totp-title" }, "Account Recovery");
  const description = createElement(
    "p",
    { class: "totp-subtitle" },
    "Sign back in without your password or two-factor device. This sets a new password and signs out every other device.",
  );
  const username = buildField("recover-username", "Username", "text", "username");
  const secret = buildField(
    "recover-secret",
    "Recovery kit secret or a recovery credential from your server owner",
    "text",
    "off",
  );
  const password = buildField("recover-password", "New password", "password", "new-password");
  const error = createElement("div", {
    class: "totp-subtitle",
    role: "alert",
    style: "color:var(--red)",
    "data-testid": "recover-error",
  });
  const submit = createElement(
    "button",
    { class: "btn-primary", type: "button", "data-testid": "recover-submit" },
    "Recover account",
  );
  const cancel = createElement(
    "button",
    { class: "totp-back", type: "button", "data-testid": "recover-cancel" },
    "Cancel",
  );
  appendChildren(
    card,
    title,
    description,
    username.group,
    secret.group,
    password.group,
    error,
    submit,
    cancel,
  );
  element.appendChild(card);

  /** Wipe the recovery secret and the new password from the DOM. */
  function close(): void {
    secret.input.value = "";
    password.input.value = "";
    setText(error, "");
    element.classList.add("totp-overlay--hidden");
  }

  function validate(host: string, user: string, key: string, pw: string): string | null {
    if (!host) return "Server address is required.";
    if (!user) return "Username is required.";
    if (!key) return "Enter your recovery kit secret or recovery credential.";
    if (pw.length < MIN_PASSWORD_LENGTH) {
      return `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (pw === ctx.placeholder) {
      return "That is the saved-password placeholder, not a password. Choose a different one.";
    }
    return null;
  }

  async function handleSubmit(): Promise<void> {
    // Re-entrancy guard, as on the 2FA box: the disabled flag brackets the
    // in-flight window, and a spent kit cannot be replayed.
    if (submit.disabled) return;
    const host = ctx.hostInput.value.trim();
    const user = username.input.value.trim();
    const key = secret.input.value.trim();
    const pw = password.input.value;
    const invalid = validate(host, user, key, pw);
    if (invalid !== null) {
      setText(error, invalid);
      return;
    }
    setText(error, "");
    submit.disabled = true;
    setText(submit, "Recovering…");
    try {
      await ctx.onRecover(host, user, key, pw);
      // Signed in: the recovery root is spent, and neither it nor the new
      // password has any business staying in the DOM.
      close();
      ctx.usernameInput.value = user;
      ctx.onRecovered();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Recovery failed.";
      setText(error, message.length > 200 ? message.slice(0, 200) + "..." : message);
    } finally {
      submit.disabled = false;
      setText(submit, "Recover account");
    }
  }

  submit.addEventListener("click", () => void handleSubmit(), { signal });
  cancel.addEventListener("click", close, { signal });
  signal.addEventListener("abort", close, { once: true });

  ctx.anchor.after(element);
  return (name) => {
    username.input.value = name;
    setText(error, "");
    element.classList.remove("totp-overlay--hidden");
    (name ? secret.input : username.input).focus();
  };
}
