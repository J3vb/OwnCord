/**
 * The message list's input wiring: the scroll listener and the delegated
 * pointer, keyboard and context-menu listeners on the content container, plus
 * the window listeners that track Shift and focus. All are owned by the list's
 * `disposable.signal`, so destroy releases them.
 */
import { readPointerEnabled } from "@lib/net/serverCapabilities";
import { openUserProfilePopup } from "../../profiles/openUserProfilePopup";
import { withMessageMenu } from "./messageMenuLoader";
import { moreButtonOf } from "./listShared";
import type { ListState, ListApi } from "./listState";
import type { ListDom } from "./listDom";

export function wireListInput(st: ListState, api: ListApi, dom: ListDom): void {
  const { root, content } = dom;

  /** The author name, avatar or user @mention chip `target` is inside, if any.
   *  @everyone/@here chips carry no `data-user-id`, so they never match. */
  function profileControlOf(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const control = target.closest<HTMLElement>(
      ".msg-author[data-user-id], .msg-avatar[data-user-id], .mention[data-user-id]",
    );
    if (
      control === null ||
      st.contentContainer === null ||
      !st.contentContainer.contains(control)
    ) {
      return null;
    }
    return control;
  }

  function openProfileFrom(target: EventTarget | null, anchorX: number, anchorY: number): void {
    const control = profileControlOf(target);
    if (control === null) return;
    const userId = Number(control.dataset["userId"]);
    if (!Number.isInteger(userId) || userId <= 0) return;
    st.closeProfilePopup = openUserProfilePopup({
      userId,
      anchorX,
      anchorY,
      signal: st.disposable.signal,
      fallbackFocus: () => (control.isConnected ? control : null),
    });
  }

  root.addEventListener("scroll", api.handleScroll, {
    signal: st.disposable.signal,
    passive: true,
  });

  // One delegated pair of listeners opens a user's profile from an author
  // name, an avatar or an @mention chip, so no row carries its own handler
  // (rows are rebuilt by virtual scrolling). Owned by disposable.signal.
  content.addEventListener(
    "click",
    (e) => {
      const control = profileControlOf(e.target);
      if (control === null) return;
      // A mention can be the label of a masked link ([@name](https://...)),
      // which would otherwise also navigate: the anchor's default action, and
      // main.ts's bubbling document listener that hands target=_blank links
      // to the system browser. Handle the click here and stop it, but only
      // inside an anchor so other document-level dismissals still see it.
      e.preventDefault();
      if (control.closest("a") !== null) e.stopPropagation();
      openProfileFrom(control, e.clientX, e.clientY);
    },
    { signal: st.disposable.signal },
  );
  content.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const control = profileControlOf(e.target);
      if (control === null) return;
      e.preventDefault();
      const rect = control.getBoundingClientRect();
      openProfileFrom(control, rect.left, rect.bottom);
    },
    { signal: st.disposable.signal },
  );
  st.disposable.signal.addEventListener("abort", () => st.closeProfilePopup?.(), { once: true });

  // One delegated listener opens the message menu, by right-click and by the
  // Menu key / Shift+F10 (which dispatch `contextmenu` to the focused control
  // with no pointer position). The lazy module decides whether the target
  // offers a menu (an image's own listener stops the event first; a text
  // field keeps the webview's own menu), and main.ts already suppresses the
  // webview's menu everywhere else, so nothing is prevented here.
  content.addEventListener(
    "contextmenu",
    (e) => {
      const { clientX: x, clientY: y, target } = e;
      withMessageMenu((m) =>
        m.openMessageMenuAt({
          opts: st.options,
          x,
          y,
          target,
          signal: st.disposable.signal,
          markUnread: api.markUnreadFrom,
        }),
      );
    },
    { signal: st.disposable.signal },
  );
  // The hover bar's "..." button: one delegated listener, so the menu is
  // owned by the list's signal and survives its row being patched or rebuilt.
  // A click on "..." while its menu is open closes it (the outside mousedown
  // already has), so the open state is noted at pointerdown, before that.
  let moreWasOpen = false;
  content.addEventListener(
    "pointerdown",
    (e) => {
      moreWasOpen = moreButtonOf(e.target)?.getAttribute("aria-expanded") === "true";
    },
    { signal: st.disposable.signal },
  );
  content.addEventListener(
    "click",
    (e) => {
      // Reset on every click, so a press on More released elsewhere cannot
      // leave the flag set; a keyboard click (detail 0) had no pointerdown.
      const skip = moreWasOpen && e.detail > 0;
      moreWasOpen = false;
      const button = moreButtonOf(e.target);
      if (button === null || skip) return;
      const testId = button.dataset["testid"] ?? "";
      withMessageMenu((m) => {
        // The first open waits for the menu module; a patch or scroll in that
        // time replaces the button, so anchor on the live one, or open nothing.
        const live = button.isConnected
          ? button
          : (st.contentContainer?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null);
        if (live === null) return;
        m.openMessageMenuFromButton({
          opts: st.options,
          button: live,
          signal: st.disposable.signal,
          markUnread: api.markUnreadFrom,
        });
      });
    },
    { signal: st.disposable.signal },
  );
  // Shift pressed before the pointer arrived still reveals Pin and Delete.
  content.addEventListener(
    "mouseover",
    (e) => {
      st.root?.classList.toggle("shift-held", e.shiftKey);
    },
    { signal: st.disposable.signal },
  );
  // Alt+click on a message row marks it unread (the lazy module decides which
  // targets count: not a link, button, image or text field).
  content.addEventListener(
    "click",
    (e) => {
      if (!e.altKey || !readPointerEnabled()) return;
      const { target } = e;
      withMessageMenu((m) =>
        m.markUnreadAt({ opts: st.options, target, markUnread: api.markUnreadFrom }),
      );
    },
    { signal: st.disposable.signal },
  );

  // Focus returning with the bottom already in view counts as seeing it.
  // Owned by disposable.signal so destroy() releases it.
  window.addEventListener("focus", () => api.markReadIfSeen(), { signal: st.disposable.signal });

  // Shift reveals the hover bar's Pin and Delete: one pair of
  // window listeners toggles a class on the list root, and CSS shows the
  // extra buttons. A lost keyup (focus left the window, the tab was hidden)
  // would leave them out, so both of those reset it. Owned by disposable.signal.
  const setShiftHeld = (held: boolean): void => {
    st.root?.classList.toggle("shift-held", held);
  };
  const trackShift = (e: KeyboardEvent): void => {
    // Releasing Shift hides the Shift-only buttons: if one holds focus, hand
    // it to the row's "..." first so it does not drop to <body>.
    if (e.type === "keyup" && !e.shiftKey) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.classList.contains("msg-shift-only")) {
        active
          .closest(".msg-actions-bar")
          ?.querySelector<HTMLElement>("[data-testid^='msg-more-']")
          ?.focus();
      }
    }
    setShiftHeld(e.shiftKey);
  };
  window.addEventListener("keydown", trackShift, { signal: st.disposable.signal });
  window.addEventListener("keyup", trackShift, { signal: st.disposable.signal });
  window.addEventListener("blur", () => setShiftHeld(false), { signal: st.disposable.signal });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) setShiftHeld(false);
    },
    { signal: st.disposable.signal },
  );
}
