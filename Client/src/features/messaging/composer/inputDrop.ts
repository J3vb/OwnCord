/**
 * The drop overlay of the message input: "Upload to #channel" over the chat
 * while a file from the OS is dragged over a slot that takes the drop.
 */
import { dialogOpen } from "@lib/ui/dialogOpen";
import { desktop } from "../../../platform/desktop";
import { createElement, appendChildren } from "@lib/dom";
import { messagingText } from "../../../i18n/messaging";
import { uploadsDisabledByServer, DROP_SLOTS } from "./inputShared";
import type { InputState } from "./inputState";
import type { NativeFile } from "../../../platform/contracts/nativeFiles";

/** `handleNativeFiles` attaches the files a host-read drop delivers. */
export function createDropOverlay(
  st: InputState,
  handleNativeFiles: (files: readonly NativeFile[]) => Promise<void>,
): (container: Element) => void {
  /** "Upload to #channel" over the chat while a file from the OS is dragged
   *  over a slot that takes the drop. It ignores the pointer, so the drop
   *  still lands on the slot underneath. */
  function wireDropOverlay(container: Element): void {
    if (st.root === null) return;
    const area = container.closest(st.options.dropZone ?? ".chat-area") ?? container;
    const overlay = createElement("div", {
      class: "drop-overlay",
      "data-testid": "drop-overlay",
      "aria-hidden": "true",
    });
    const card = createElement("div", { class: "drop-overlay-card" });
    appendChildren(
      card,
      createElement("strong", {}, messagingText("drop.title", { channel: st.options.channelName })),
      createElement("span", {}, messagingText("drop.hint")),
    );
    overlay.appendChild(card);
    overlay.hidden = true;
    st.root.appendChild(overlay);
    const hide = (): void => {
      overlay.hidden = true;
    };
    const showOver = (target: EventTarget | null): void => {
      if (!acceptsDropAt(target)) {
        hide();
        return;
      }
      if (!overlay.hidden) return;
      const r = area.getBoundingClientRect();
      overlay.style.top = `${r.top}px`;
      overlay.style.left = `${r.left}px`;
      overlay.style.width = `${r.width}px`;
      overlay.style.height = `${r.height}px`;
      overlay.hidden = false;
    };
    document.addEventListener(
      "dragover",
      (e: DragEvent) => {
        if (e.dataTransfer?.types.includes("Files") !== true) return;
        showOver(e.target);
      },
      { signal: st.signal },
    );
    wireNativeDrops(showOver, hide);
    // A null relatedTarget is the drag leaving the window.
    document.addEventListener(
      "dragleave",
      (e: DragEvent) => {
        if (e.relatedTarget === null) hide();
      },
      { signal: st.signal },
    );
    document.addEventListener("drop", hide, { signal: st.signal });
    document.addEventListener("dragend", hide, { signal: st.signal });
  }

  /** A file dragged in from the OS lands on `target`: true when this
   *  composer takes it. */
  function acceptsDropAt(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      target.closest(st.options.dropZone ?? DROP_SLOTS) !== null &&
      st.disabledReason === null &&
      !uploadsDisabledByServer() &&
      !dialogOpen()
    );
  }

  /** Drops the host reads itself (Linux): the overlay follows the native
   *  drag, and a drop over a slot that takes it attaches the files. */
  function wireNativeDrops(showOver: (target: Element | null) => void, hide: () => void): void {
    if (!desktop.nativeFiles.available) return;
    const stop = desktop.nativeFiles.onDrag((drag) => {
      if (st.signal.aborted) return;
      if (drag.kind === "leave") {
        hide();
        return;
      }
      const target = document.elementFromPoint(drag.x, drag.y);
      if (drag.kind === "over") {
        showOver(target);
        return;
      }
      hide();
      if (acceptsDropAt(target)) void handleNativeFiles(drag.files);
    });
    st.signal.addEventListener("abort", stop, { once: true });
  }
  return wireDropOverlay;
}
