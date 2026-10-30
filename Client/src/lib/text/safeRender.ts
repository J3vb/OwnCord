// Step 1.13 — Error boundary / safe render utility

import { createLogger } from "../logger";
import { connectText } from "../../i18n/connect";

const log = createLogger("safe-render");

/**
 * Minimal component interface for safe mounting.
 */
export interface MountableComponent {
  mount(container: Element): void;
  destroy?(): void;
}

/**
 * The two ways out of a failed page. The app shell supplies both so this
 * module stays self-contained: it imports nothing heavy, and still works when
 * most of the app failed to load.
 */
export interface RenderRecovery {
  /** Leave any call, then reload the page. */
  readonly reload: () => void | Promise<void>;
  /** End the session and return to the connect page. */
  readonly signOut: () => void;
}

/**
 * Safely mount a component, catching any errors during rendering.
 * On failure, displays a fallback UI instead of crashing the app. With
 * `recovery`, the fallback offers Reload and Sign out.
 */
export function safeMount(
  component: MountableComponent,
  container: Element,
  recovery?: RenderRecovery,
): void {
  try {
    component.mount(container);
  } catch (err) {
    log.error("Component mount failed", err);
    renderFallback(container, err, recovery);
  }
}

function recoveryButton(
  label: string,
  testId: string,
  action: () => void | Promise<void>,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.style.cssText =
    "padding:6px 14px;border:0;border-radius:4px;background:#4e5058;color:#f2f3f5;font-size:13px;cursor:pointer;";
  button.dataset.testid = testId;
  button.textContent = label;
  button.addEventListener("click", () => {
    try {
      const done = action();
      if (done instanceof Promise) {
        done.catch((err: unknown) => log.error("Recovery action failed", err));
      }
    } catch (err) {
      log.error("Recovery action failed", err);
    }
  });
  return button;
}

/**
 * Render a minimal fallback UI when a page or component fails. Exported so the
 * shell can show it when a page chunk fails to load, before anything mounts.
 */
export function renderFallback(
  container: Element,
  error: unknown,
  recovery?: RenderRecovery,
): void {
  container.textContent = "";
  const fallback = document.createElement("div");
  fallback.style.cssText =
    "padding:16px;color:#f23f43;background:#2b2d31;border-radius:8px;font-size:13px;margin:8px;";
  fallback.textContent = connectText("app.renderFailed");
  container.appendChild(fallback);

  // Log the actual error for debugging
  if (error instanceof Error) {
    const detail = document.createElement("pre");
    detail.style.cssText =
      "color:#949ba4;font-size:11px;margin-top:8px;white-space:pre-wrap;word-break:break-all;";
    detail.textContent = error.message;
    fallback.appendChild(detail);
  }

  if (recovery !== undefined) {
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;margin-top:12px;";
    actions.appendChild(
      recoveryButton(connectText("app.reload"), "render-fallback-reload", recovery.reload),
    );
    actions.appendChild(
      recoveryButton(connectText("app.signOut"), "render-fallback-sign-out", recovery.signOut),
    );
    fallback.appendChild(actions);
  }
}

/**
 * Install global error handlers.
 * Call once at app startup.
 */
export function installGlobalErrorHandlers(): void {
  window.addEventListener("error", (event) => {
    log.error("Uncaught error", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error instanceof Error ? event.error.stack : String(event.error),
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason =
      event.reason instanceof Error
        ? (event.reason.stack ?? event.reason.message)
        : String(event.reason);

    // Tauri plugin-http GC cleanup: when a consumed Response body is finalized,
    // Tauri tries to drop the Rust resource which may already be freed.
    // This is cosmetic — downgrade to debug instead of polluting error logs.
    if (typeof reason === "string" && /resource id .+ is invalid/.test(reason)) {
      log.debug("Tauri resource already freed (benign)", { reason });
      return;
    }

    log.error("Unhandled promise rejection", { reason });
  });

  log.info("Global error handlers installed");
}
