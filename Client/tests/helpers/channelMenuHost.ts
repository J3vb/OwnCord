import { afterEach, beforeEach } from "vitest";
import { attachChannelContextMenu } from "../../src/components/channel-sidebar/contextMenu";
import type { Channel } from "../../src/stores/channels.store";

/**
 * Gives each test a container on the body and a fresh AbortController, and
 * afterwards aborts it, removes the container and sweeps any open channel menu.
 */
export function useChannelMenuHost(
  bind: (container: HTMLDivElement, ac: AbortController) => void,
): void {
  let container: HTMLDivElement;
  let ac: AbortController;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    ac = new AbortController();
    bind(container, ac);
  });

  afterEach(() => {
    ac.abort();
    container.remove();
    document.querySelectorAll(".channel-ctx-menu").forEach((el) => el.remove());
  });
}

/** Right-clicks `el` at (4, 4). */
export function contextMenuAt4(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
}

/** Attaches the channel menu to a fresh row in `container` and right-clicks it. */
export function openChannelMenu(
  container: HTMLElement,
  channel: Channel,
  signal: AbortSignal,
): HTMLElement {
  const el = document.createElement("div");
  container.appendChild(el);
  attachChannelContextMenu(el, channel, signal, signal);
  contextMenuAt4(el);
  return el;
}
