/**
 * Shared shape behind an overlay that opens by awaiting a fetch, plus the
 * outside-press close a side panel uses.
 */

import type { MountableComponent } from "@lib/text/safeRender";
import { Disposable } from "@lib/disposable";
import { appendChildren, createElement } from "@lib/dom";
import { createModal } from "@lib/ui/modalFactory";
import { claimBackOnPhone } from "@lib/ui/bottomSheet";
import { createLogger } from "@lib/logger";
import { showToast } from "@lib/ui/toast";
import { dialogOpen } from "@lib/ui/dialogOpen";
import { shellText } from "../../i18n/shell";

const log = createLogger("overlays");

/** Inline load-failure dialog: the message, Retry and Close. */
function mountLoadError(
  root: HTMLDivElement,
  copy: { readonly message: string; readonly retryLabel: string },
  onClose: () => void,
  onRetry: () => void,
): MountableComponent {
  const content = createElement("div", { class: "modal-body" });
  content.appendChild(
    createElement("div", { class: "invite-manager__error", role: "alert" }, copy.message),
  );
  const footer = createElement("div", { class: "modal-footer" });
  const closeBtn = createElement(
    "button",
    { class: "btn-modal-cancel" },
    shellText("common.close"),
  );
  const retryBtn = createElement("button", { class: "btn-modal-save" }, copy.retryLabel);
  closeBtn.addEventListener("click", onClose);
  retryBtn.addEventListener("click", onRetry);
  appendChildren(footer, closeBtn, retryBtn);
  const disposable = new Disposable();
  const modal = createModal(
    {
      content,
      closeOnBackdrop: false,
      onClose,
      ariaLabel: copy.message,
      signal: disposable.signal,
    },
    root,
  );
  modal.modal.appendChild(footer);
  return {
    mount: () => undefined,
    destroy: () => {
      disposable.destroy();
      modal.destroy();
    },
  };
}

/** What counts as "inside" a side panel for closeOnOutsidePress. */
export interface OutsidePressTargets {
  /** Selector of the panel's own element under the root. */
  readonly panel: string;
  /** Selector of the header button that toggles the panel: its click closes it. */
  readonly toggle: string;
}

// Layers stacked over the page (a dialog, menu, sheet, toast or image viewer):
// a press there belongs to that layer, not to the page behind the panel.
const FLOATING_LAYERS =
  '.modal-overlay, [aria-modal="true"], [role="dialog"], .context-menu, .bottom-sheet-overlay, .toast-container, .image-lightbox';

/**
 * Close a side panel when a press lands outside it. Listens on pointerdown in
 * the capture phase, so a click that re-renders or removes its target inside
 * the panel still counts as inside, and a handler that stops propagation
 * cannot hide the press.
 */
export function closeOnOutsidePress(
  root: ParentNode,
  targets: OutsidePressTargets,
  onClose: () => void,
  signal: AbortSignal,
): void {
  document.addEventListener(
    "pointerdown",
    (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (root.querySelector(targets.panel)?.contains(target) === true) return;
      if (target.closest(targets.toggle) !== null) return;
      if (target.closest(FLOATING_LAYERS) !== null || dialogOpen()) return;
      onClose();
    },
    { capture: true, signal },
  );
}

/**
 * Shared shape behind an overlay that opens by awaiting a fetch: an
 * instance/opening guard against a double-click during the round trip,
 * post-await `getRoot()` re-derivation (a page teardown during the fetch
 * nulls the root MainPage handed out, but the pre-await root still points at
 * the now-detached node — mounting on it would create an instance whose
 * document-level listeners nothing ever tears down), catch -> log -> toast,
 * and `finally opening = false`. A close() during the fetch cancels that
 * open: its result is dropped rather than mounted.
 */
export function createAsyncOverlayController<T>(opts: {
  readonly getRoot: () => HTMLDivElement | null;
  /** Extra precondition (besides instance/root/opening) checked before the
   *  fetch starts; open() bails silently (no log, no toast) if it returns
   *  false. Runs before `opening` is set. */
  readonly canOpen?: () => boolean;
  readonly load: () => Promise<T>;
  readonly build: (data: T, root: HTMLDivElement, close: () => void) => MountableComponent;
  readonly errorLog: string;
  readonly errorToast: string;
  /** When set, a failed load also mounts an inline error dialog with a Retry
   *  button (re-runs the load) instead of leaving only the toast. */
  readonly inlineError?: { readonly message: string; readonly retryLabel: string };
  /** A side panel closes on a press outside it (see closeOnOutsidePress). */
  readonly outsidePress?: OutsidePressTargets;
  /** A side panel closes on Back on the phone layout (see claimBackOnPhone). */
  readonly backOnPhone?: boolean;
}): { open(): Promise<void>; close(): void; isOpen(): boolean } {
  let instance: MountableComponent | null = null;
  let opening = false;
  let generation = 0;
  /** The mounted panel's lifetime: its outside-press and Back hooks. */
  let mounted: Disposable | null = null;

  function close(): void {
    generation++;
    opening = false;
    mounted?.destroy();
    mounted = null;
    if (instance !== null) {
      instance.destroy?.();
      instance = null;
    }
  }

  function mountLoaded(data: T, liveRoot: HTMLDivElement): void {
    instance = opts.build(data, liveRoot, close);
    instance.mount(liveRoot);
    mounted = new Disposable();
    if (opts.outsidePress !== undefined)
      closeOnOutsidePress(liveRoot, opts.outsidePress, close, mounted.signal);
    if (opts.backOnPhone === true) claimBackOnPhone(close, mounted.signal);
  }

  function showLoadFailure(err: unknown): void {
    log.error(opts.errorLog, { error: String(err) });
    // The inline dialog carries the message; other overlays only toast.
    if (opts.inlineError === undefined) showToast(opts.errorToast, "error");
    const liveRoot = opts.getRoot();
    if (opts.inlineError !== undefined && liveRoot !== null) {
      instance = mountLoadError(liveRoot, opts.inlineError, close, () => {
        close();
        void open();
      });
    }
  }

  async function open(): Promise<void> {
    const root = opts.getRoot();
    if (instance !== null || root === null || opening) return;
    if (opts.canOpen?.() === false) return;
    opening = true;
    const gen = generation;
    try {
      const data = await opts.load();
      if (gen !== generation) return;
      const liveRoot = opts.getRoot();
      if (liveRoot === null) return;
      mountLoaded(data, liveRoot);
    } catch (err) {
      if (gen !== generation) return;
      showLoadFailure(err);
    } finally {
      if (gen === generation) opening = false;
    }
  }

  return { open, close, isOpen: () => instance !== null };
}
