// Step 1.13 — Error boundary / safe render utility

import { createLogger } from "./logger";

const log = createLogger("safe-render");

/**
 * Minimal component interface for safe mounting.
 */
export interface MountableComponent {
  mount(container: Element): void;
  destroy?(): void;
}

/**
 * Safely mount a component, catching any errors during rendering.
 * On failure, displays a fallback UI instead of crashing the app.
 */
export function safeMount(
  component: MountableComponent,
  container: Element,
): void {
  try {
    component.mount(container);
  } catch (err) {
    log.error("Component mount failed", err);
    renderFallback(container, err);
  }
}

/**
 * Render a minimal fallback UI when a component fails.
 */
function renderFallback(container: Element, error: unknown): void {
  container.textContent = "";
  const fallback = document.createElement("div");
  fallback.style.cssText =
    "padding:16px;color:#f23f43;background:#2b2d31;border-radius:8px;font-size:13px;margin:8px;";
  fallback.textContent = "Something went wrong rendering this section.";
  container.appendChild(fallback);

  // Log the actual error for debugging
  if (error instanceof Error) {
    const detail = document.createElement("pre");
    detail.style.cssText =
      "color:#949ba4;font-size:11px;margin-top:8px;white-space:pre-wrap;word-break:break-all;";
    detail.textContent = error.message;
    fallback.appendChild(detail);
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
    log.error("Unhandled promise rejection", {
      reason:
        event.reason instanceof Error
          ? event.reason.stack
          : String(event.reason),
    });
  });

  log.info("Global error handlers installed");
}
