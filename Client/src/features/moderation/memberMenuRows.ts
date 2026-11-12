/**
 * Row builders for the member context menu: plain and flyout rows, the two-click
 * confirm, the voice moderation rows and the Block toggle.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createMenuItem as buildMenuItem } from "@lib/ui/contextMenu";
import { shellText } from "../../i18n/shell";
import { voiceText } from "../../i18n/voice";
import type { VoiceModMenuOptions } from "../channels/sidebar/volumeMenu";
import type { MemberContextMenuOptions } from "./memberMenuTypes";

export function createMenuItem(
  label: string,
  className: string,
  onClick: () => void,
  signal: AbortSignal,
): HTMLElement {
  const item = buildMenuItem(label, className);
  item.addEventListener("click", onClick, { signal });
  return item;
}

export function createSeparator(): HTMLDivElement {
  return createElement("div", { class: "context-menu__separator" });
}

/** How long a "Are you sure?" state stays armed before reverting. */
const CONFIRM_TIMEOUT_MS = 4000;

/**
 * Two-click confirm with an in-flight state.
 *
 * The armed state auto-disarms after a few seconds so a menu left open doesn't
 * turn a stray second click into a ban, and the item shows progress while the
 * request is running — a slow force logout used to look like nothing happened.
 */
export function withConfirmation(
  item: HTMLElement,
  confirmLabel: string,
  onConfirm: () => void | Promise<void>,
  signal: AbortSignal,
  pendingLabel = shellText("common.working"),
): void {
  let confirming = false;
  let running = false;
  let disarmTimer: ReturnType<typeof setTimeout> | null = null;
  const originalLabel = item.textContent ?? "";

  function disarm(): void {
    confirming = false;
    if (disarmTimer !== null) {
      clearTimeout(disarmTimer);
      disarmTimer = null;
    }
    setText(item, originalLabel);
  }

  signal.addEventListener("abort", () => {
    if (disarmTimer !== null) clearTimeout(disarmTimer);
  });

  item.addEventListener(
    "click",
    (e) => {
      e.stopPropagation();
      if (running) return;
      if (!confirming) {
        confirming = true;
        setText(item, confirmLabel);
        disarmTimer = setTimeout(disarm, CONFIRM_TIMEOUT_MS);
        return;
      }
      if (disarmTimer !== null) {
        clearTimeout(disarmTimer);
        disarmTimer = null;
      }
      confirming = false;
      running = true;
      setText(item, pendingLabel);
      item.classList.add("context-menu__item--pending");
      const done = (): void => {
        running = false;
        item.classList.remove("context-menu__item--pending");
        setText(item, originalLabel);
      };
      const result = onConfirm();
      if (result instanceof Promise) {
        void result.then(done, done);
      } else {
        done();
      }
    },
    { signal },
  );
}

/** One flat menu row. `disabledReason` greys it and keeps it inert; the reason
 *  shows as its tooltip. */
export function appendRow(
  parent: Node,
  label: string,
  onClick: () => void,
  signal: AbortSignal,
  opts: { testId?: string; disabledReason?: string } = {},
): HTMLElement {
  const item = buildMenuItem(
    label,
    "context-menu__item",
    opts.testId === undefined ? {} : { testId: opts.testId },
  );
  if (opts.disabledReason !== undefined) {
    item.setAttribute("aria-disabled", "true");
    item.title = opts.disabledReason;
  } else {
    item.addEventListener("click", onClick, { signal });
  }
  parent.appendChild(item);
  return item;
}

/** A submenu trigger whose flyout opens on hover (the keyboard path is the
 *  same reveal plus focus, in context-menu.ts). */
export function buildFlyout(
  label: string,
  fill: (flyout: HTMLElement) => void,
  signal: AbortSignal,
): HTMLElement {
  const trigger = buildMenuItem(label, "context-menu__item", { submenu: true });
  const flyout = createElement("div", { class: "context-menu__submenu" });
  fill(flyout);
  trigger.addEventListener(
    "mouseenter",
    () => {
      flyout.style.display = "";
    },
    { signal },
  );
  trigger.addEventListener(
    "mouseleave",
    () => {
      flyout.style.display = "none";
    },
    { signal },
  );
  flyout.style.display = "none";
  appendChildren(trigger, flyout);
  return trigger;
}

/** Server Mute / Deafen / Disconnect for a target in a server voice channel. */
export function appendVoiceRows(
  parent: Node,
  mod: VoiceModMenuOptions | string,
  close: () => void,
  signal: AbortSignal,
): void {
  const reason = typeof mod === "string" ? mod : mod.disabledReason;
  const muted = typeof mod !== "string" && mod.serverMuted === true;
  const deafened = typeof mod !== "string" && mod.serverDeafened === true;
  // A Move Members-only verdict carries no mute, deafen or
  // disconnect handler, and the member menu offers no Move: show only the
  // rows the options can run. A string (the reason) still shows all three.
  const has = (pick: (m: VoiceModMenuOptions) => unknown): boolean =>
    typeof mod === "string" || pick(mod) !== undefined;
  const run = (action: (m: VoiceModMenuOptions) => void) => (): void => {
    if (typeof mod === "string") return;
    action(mod);
    close();
  };
  const opts = (testId: string): { testId: string; disabledReason?: string } =>
    reason === undefined ? { testId } : { testId, disabledReason: reason };
  if (has((m) => m.onServerMute)) {
    appendRow(
      parent,
      voiceText(muted ? "volume.serverUnmute" : "volume.serverMute"),
      run((m) => m.onServerMute?.(!muted)),
      signal,
      opts("member-menu-server-mute"),
    );
  }
  if (has((m) => m.onServerDeafen)) {
    appendRow(
      parent,
      voiceText(deafened ? "volume.serverUndeafen" : "volume.serverDeafen"),
      run((m) => m.onServerDeafen?.(!deafened)),
      signal,
      opts("member-menu-server-deafen"),
    );
  }
  if (has((m) => m.onDisconnect)) {
    appendRow(
      parent,
      voiceText("volume.disconnect"),
      run((m) => m.onDisconnect?.()),
      signal,
      opts("member-menu-disconnect"),
    );
  }
}

export function buildBlockItem(
  options: MemberContextMenuOptions,
  closeMenu: () => void,
  signal: AbortSignal,
): HTMLElement {
  const blockItem = buildMenuItem(
    shellText(options.isBlocked ? "member.unblock" : "member.block"),
    options.isBlocked ? "context-menu__item" : "context-menu__item context-menu__item--danger",
    { testId: "block-toggle" },
  );
  if (options.isBlocked) {
    let unblockRunning = false;
    blockItem.addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        if (unblockRunning) return;
        unblockRunning = true;
        setText(blockItem, shellText("member.unblocking"));
        blockItem.classList.add("context-menu__item--pending");
        const done = (): void => {
          unblockRunning = false;
          blockItem.classList.remove("context-menu__item--pending");
          setText(blockItem, shellText("member.unblock"));
          // The menu was built for the old block state: reopening shows the new one.
          closeMenu();
        };
        void options.onToggleBlock().then(done, done);
      },
      { signal },
    );
  } else {
    withConfirmation(
      blockItem,
      shellText("common.areYouSure"),
      () => options.onToggleBlock().finally(closeMenu),
      signal,
      shellText("member.blocking"),
    );
  }
  return blockItem;
}
