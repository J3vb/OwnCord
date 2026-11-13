/** Shared shape behind an overlay that opens by awaiting a fetch. */

import type { MountableComponent } from "@lib/text/safeRender";
import { Disposable } from "@lib/disposable";
import { appendChildren, createElement } from "@lib/dom";
import { createModal } from "@lib/ui/modalFactory";
import { bindSidePanel, type SidePanelTargets } from "@lib/ui/sidePanel";
import { createLogger } from "@lib/logger";
import { showToast } from "@lib/ui/toast";
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
  /** Checked once the load lands, and by an open() during the load: true
   *  drops the result unmounted (what it was opened for is gone, such as the
   *  channel the viewer left) and lets a new open() start over. */
  readonly isStale?: () => boolean;
  /** A channel side panel: its shared behaviour (see bindSidePanel). */
  readonly sidePanel?: SidePanelTargets;
}): { open(): Promise<void>; close(): void; isOpen(): boolean; isPending(): boolean } {
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
    if (opts.sidePanel !== undefined)
      bindSidePanel(liveRoot, opts.sidePanel, close, mounted.signal);
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
    if (instance !== null || root === null) return;
    // A load still wanted runs on; a stale one (the viewer moved on) is
    // cancelled, so this open starts over for what is current now.
    if (opening) {
      if (isPending()) return;
      close();
    }
    if (opts.canOpen?.() === false) return;
    opening = true;
    const gen = generation;
    try {
      const data = await opts.load();
      if (gen !== generation) return;
      const liveRoot = opts.getRoot();
      if (liveRoot === null || opts.isStale?.() === true) return;
      mountLoaded(data, liveRoot);
    } catch (err) {
      if (gen !== generation) return;
      showLoadFailure(err);
    } finally {
      if (gen === generation) opening = false;
    }
  }

  function isPending(): boolean {
    return opening && opts.isStale?.() !== true;
  }

  return { open, close, isOpen: () => instance !== null, isPending };
}
