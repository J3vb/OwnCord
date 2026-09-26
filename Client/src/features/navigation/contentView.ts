/**
 * The content navigator (B9-4): opens a destination's view in place of the
 * chat column and owns everything about its lifetime.
 *
 * - One view at a time. Opening another, choosing a channel or DM, losing the
 *   destination's permission, signing out and page teardown each destroy the
 *   view and abort its signal, so a late result cannot render into it.
 * - While a view is open no channel is active: nothing is on screen, so
 *   unread counts and notifications keep counting, and MainPage's
 *   active-channel subscriber tears the chat surface down.
 * - Close and Escape take the Q2 back path: the channel the user came from.
 *   Focus returns to the entry that opened the view, or to a fallback when
 *   that entry is gone.
 *
 * The view state lives in `uiStore.activeView`; this is its only writer.
 */

import type { ApiClient } from "@lib/api";
import { Disposable } from "@lib/disposable";
import { createElement, clearChildren, setOwnedTimeout } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { createLogger } from "@lib/logger";
import { canModerateMembers } from "@lib/permissions";
import { authStore, onAuthCleared } from "@stores/auth.store";
import { channelsStore, setActiveChannel } from "@stores/channels.store";
import { setActiveView, uiStore } from "@stores/ui.store";
import { navigationText } from "../../i18n/navigation";
import type { ContentViewId, FeatureViewBuilder, NavigationDestinations } from "./destinations";

const log = createLogger("content-view");

export interface ContentNavigatorOptions {
  readonly destinations: NavigationDestinations;
  /** Handed to each view's builder. */
  readonly api: ApiClient;
  /** The chat column. Hidden while a view is open. */
  readonly chatArea: HTMLElement;
  /** Remember the channel on screen as the one to go back to (channelBeforeDm). */
  readonly rememberChannel: () => void;
  /** Drop the remembered channel: the user chose another one instead of going back. */
  readonly forgetChannel: () => void;
  /** Go back to the remembered channel (the DM sidebar's back path). */
  readonly returnToChannel: () => void;
  /** Focus something reachable when the opener is gone. Runs after the channel remounts. */
  readonly fallbackFocus: () => void;
}

export interface ContentNavigator {
  /** The view's column, a sibling of the chat column. */
  readonly element: HTMLElement;
  /** Open `id`. `opener` gets focus back on close. A no-op when unavailable. */
  open(id: ContentViewId, opener: HTMLElement | null): void;
  /** Close the open view and go back, as its Close button does. */
  close(): void;
  destroy(): void;
}

const TITLE: Readonly<Record<ContentViewId, "requests.title" | "moderation.title">> = {
  requests: "requests.title",
  moderation: "moderation.title",
};

export function createContentNavigator(opts: ContentNavigatorOptions): ContentNavigator {
  const { destinations, chatArea } = opts;
  const page = new Disposable();

  const element = createElement("div", {
    class: "chat-area feature-view",
    "data-testid": "feature-view",
    style: "display:none",
  });

  let current: { id: ContentViewId; owner: Disposable; opener: HTMLElement | null } | null = null;

  function builderFor(id: ContentViewId): FeatureViewBuilder | null {
    if (id === "requests") return destinations.requests?.build ?? null;
    if (!canModerateMembers()) return null;
    return destinations.moderation?.build ?? null;
  }

  /** Destroy the open view and put the chat column back. Returns its opener. */
  function teardown(): HTMLElement | null {
    if (current === null) return null;
    const { owner, opener } = current;
    current = null;
    owner.destroy();
    clearChildren(element);
    element.removeAttribute("aria-labelledby");
    element.style.display = "none";
    chatArea.style.display = "";
    setActiveView(null);
    return opener;
  }

  function restoreFocus(opener: HTMLElement | null): void {
    // The back path remounts the sidebar and the channel from store
    // notifications, which can remove the opener (the Requests entry leaves
    // with DM mode) or create the fallback (the composer), so decide after.
    setOwnedTimeout(
      page.signal,
      () => {
        if (
          opener !== null &&
          opener.isConnected &&
          opener.style.display !== "none" &&
          opener.closest("[inert]") === null
        ) {
          opener.focus();
        } else {
          opts.fallbackFocus();
        }
      },
      0,
    );
  }

  /** Close and take the back path. */
  function close(): void {
    if (current === null) return;
    const opener = teardown();
    opts.returnToChannel();
    restoreFocus(opener);
  }

  function open(id: ContentViewId, opener: HTMLElement | null): void {
    if (page.signal.aborted) return;
    const build = builderFor(id);
    if (build === null) return;
    if (current?.id === id) {
      element.querySelector<HTMLElement>(".feature-view-title")?.focus();
      return;
    }
    // Switching views keeps the first opener: that is where the user started.
    const keptOpener = current !== null ? current.opener : opener;
    teardown();
    opts.rememberChannel();

    const owner = new Disposable();
    current = { id, owner, opener: keptOpener };
    setActiveView(id);
    setActiveChannel(null);

    const name = navigationText(TITLE[id]);
    const titleId = `feature-view-title-${id}`;
    const header = createElement("div", { class: "chat-header" });
    const title = createElement(
      "h2",
      { class: "ch-name feature-view-title", id: titleId, tabindex: "-1" },
      name,
    );
    const tools = createElement("div", { class: "ch-tools" });
    const closeBtn = createElement("button", {
      type: "button",
      class: "feature-view-close",
      "aria-label": navigationText("view.close", { name }),
      title: navigationText("view.close", { name }),
      "data-testid": "feature-view-close",
    });
    closeBtn.appendChild(createIcon("x", 18));
    closeBtn.addEventListener("click", close, { signal: owner.signal });
    tools.appendChild(closeBtn);
    header.append(title, tools);

    const body = createElement("div", { class: "feature-view-body" });
    element.append(header, body);
    element.setAttribute("role", "region");
    element.setAttribute("aria-labelledby", titleId);
    element.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        // A control inside the view that handles Escape itself (a menu, an
        // edit field) marks it handled first.
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        close();
      },
      { signal: owner.signal },
    );

    try {
      body.appendChild(build({ signal: owner.signal, close, api: opts.api }));
    } catch (err) {
      log.error("Feature view failed to build", { id, error: String(err) });
      close();
      return;
    }
    chatArea.style.display = "none";
    element.style.display = "";
    title.focus();
  }

  // Choosing a channel or DM while a view is open replaces it. The back path
  // itself lands here too, after teardown, so this is then a no-op.
  page.onStoreChange(
    channelsStore,
    (s) => s.activeChannelId,
    (id: number | null) => {
      if (id === null || current === null) return;
      teardown();
      if (channelsStore.getState().channels.get(id)?.type !== "dm") opts.forgetChannel();
    },
  );

  // Permission loss removes the destination and its private view at once.
  const recheck = (): void => {
    if (current?.id === "moderation" && !canModerateMembers()) close();
  };
  page.onStoreChange(authStore, (s) => s.user?.role ?? null, recheck);
  page.onStoreChange(channelsStore, (s) => s.roles, recheck);

  // A profile switch or logout clears the view before the page unmounts.
  page.addCleanup(onAuthCleared(() => teardown()));

  return {
    element,
    open,
    close,
    destroy: () => {
      teardown();
      page.destroy();
    },
  };
}

/** Keep `el`'s aria-current in step with whether `id` is the open view. Returns the unsubscribe. */
export function trackCurrentView(el: HTMLElement, id: ContentViewId): () => void {
  const sync = (view: ContentViewId | null): void => {
    if (view === id) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  };
  sync(uiStore.getState().activeView);
  return uiStore.subscribeSelector((s) => s.activeView, sync);
}
