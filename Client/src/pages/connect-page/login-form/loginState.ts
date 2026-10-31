/** The mutable state one login form keeps, shared by its modules. */
import type { RegistrationMode } from "@lib/types";
import type { RecoverContext } from "../RecoverOverlay";
import type { LimitHint } from "@lib/text/nameLimits";
import type { FieldId } from "./loginShared";
import type { FormState, FormMode, LoginFormOptions } from "../LoginForm";

export interface LoginFormState {
  readonly opts: LoginFormOptions;
  readonly signal: AbortSignal;
  readonly onLogin: (host: string, username: string, password: string) => Promise<void>;
  readonly onLoginWithSavedPassword: (host: string, username: string) => Promise<void>;
  readonly onRegister: (
    host: string,
    username: string,
    password: string,
    inviteCode: string,
  ) => Promise<void>;
  readonly onTotpSubmit: (code: string) => Promise<void>;
  readonly onRecover:
    | ((host: string, username: string, secret: string, newPassword: string) => Promise<void>)
    | undefined;
  readonly onSettingsOpen: () => void;
  readonly onAutoLoginCancel: (() => void) | undefined;
  readonly getRegistrationMode: ((host: string) => RegistrationMode | null) | undefined;
  readonly getRetentionNotice: ((host: string) => string | null) | undefined;
  readonly onHostSettled: ((host: string) => void) | undefined;
  readonly onHostInput: ((host: string) => void) | undefined;
  readonly getSavedHosts: (() => readonly string[]) | undefined;
  readonly fixedHost: string | undefined;
  // Debounce token: only the latest scheduled host-settled call fires.
  hostSettledSeq: number;
  usingSavedPassword: boolean;
  formState: FormState;
  formMode: FormMode;
  errorMessage: string;
  // A non-error notice (pending approval). Shown until the form next goes busy
  // or an error replaces it.
  noticeMessage: string;
  /**
   * The field the current banner error belongs to, so the error is
   * linked to its input with aria-describedby/aria-invalid and focus moves
   * there. Null for a server error that names no field.
   */
  errorField: FieldId | null;
  // True while a TOTP challenge is outstanding (from showTotp() until it is
  // cancelled or resolved). A rejected verify moves formState to "error" for
  // the banner/shake, but the overlay must stay up so the code can be
  // re-entered — see updateTotpOverlay().
  totpPending: boolean;
  // The last submit the desktop proxy refused because its host's certificate
  // was not confirmed yet. Accepting that certificate resubmits it once.
  certRefusedSubmit: { host: string; mode: FormMode } | null;
  // What had focus when a request disabled the form, restored when it settles.
  focusBeforeBusy: Element | null;
  formTitle: HTMLHeadingElement;
  hostInput: HTMLInputElement;
  usernameInput: HTMLInputElement;
  // The new-username rules, shown under the field in Register only (an
  // existing account may predate them, so Login keeps the field unbounded).
  usernameHint: LimitHint;
  usernameCap: number;
  passwordInput: HTMLInputElement;
  inviteGroup: HTMLDivElement;
  inviteInput: HTMLInputElement;
  registrationNotice: HTMLDivElement;
  submitBtn: HTMLButtonElement;
  submitBtnText: HTMLSpanElement;
  toggleModeBtn: HTMLButtonElement;
  errorBanner: HTMLDivElement;
  infoNotice: HTMLDivElement;
  totpInput: HTMLInputElement;
  totpError: HTMLDivElement;
  totpSubmitBtn: HTMLButtonElement;
  rememberPasswordCheckbox: HTMLInputElement;
  autoConnectCheckbox: HTMLInputElement;
  autoConnectServerName: HTMLSpanElement;
  serverWait: HTMLDivElement;
  serverWaitText: HTMLSpanElement;
  serverWaitHost: string;
  authBusyRetry: HTMLDivElement;
  /** The busy line's Cancel: ends the wait and stops the AUTH_BUSY retries. */
  cancelAuthBusyRetry: (() => void) | null;
  panelEl: HTMLDivElement;
  statusBar: HTMLDivElement;
  statusBarFill: HTMLDivElement;
  totpOverlay: HTMLDivElement;
  autoConnectOverlay: HTMLDivElement;
  // Account recovery (lazy: the overlay module loads on first use)

  // One context per form: it is the overlay module's cache key.
  recoverCtx: RecoverContext | undefined;
}

/** Every function the login form's modules share, filled in once by createLoginForm. */
export interface LoginFormInternals {
  clearSavedPasswordPlaceholder(): void;
  buildFormPanel(): HTMLDivElement;
  buildFormGroup(
    id: string,
    labelText: string,
    inputType: string,
    placeholder: string,
  ): HTMLDivElement;
  buildTotpOverlay(): HTMLDivElement;
  buildAutoConnectOverlay(): HTMLDivElement;
  buildServerWait(): HTMLDivElement;
  buildAuthBusyRetry(): HTMLDivElement;
  cancelServerWait(): void;
  transitionTo(state: FormState, error?: string, field?: FieldId | null): void;
  fieldInput(field: FieldId): HTMLInputElement;
  updateSubmitButton(): void;
  allFieldInputs(): HTMLInputElement[];
  updateErrorBanner(): void;
  updateInfoNotice(): void;
  updateStatusBar(): void;
  updateTotpOverlay(): void;
  updateAutoConnectOverlay(): void;
  updateFormInputsDisabled(): void;
  currentRegistrationMode(): RegistrationMode | null;
  isRegisterRefused(): boolean;
  updateRegistrationUi(): void;
  currentHost(): string;
  writeHost(host: string): void;
  scheduleHostSettled(delayMs?: number): void;
  applyUsernameRules(): void;
  handleToggleMode(): void;
  validateForm(): {
    message: string;
    field: FieldId | null;
    /** The message is shown under the field (its hint); the banner points there. */
    inline?: boolean;
  } | null;
  loginRetryingWhileBusy(login: () => Promise<void>): Promise<void>;
  handleFormSubmit(e: Event): Promise<void>;
  handleTotpSubmit(): Promise<void>;
  handleTotpCancel(): void;
  openRecover(): void;
}
