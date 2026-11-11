/** The self profile card's header: avatar, display name, username and the
 *  custom status line with its "Clears at" note. */

import { createElement, appendChildren, setText } from "@lib/dom";
import { resolveDisplayName } from "@lib/ui/avatar";
import { authStore } from "@stores/auth.store";
import { customStatusClearsLine, parseExpiry } from "../presence/statusDefs";
import { shellText } from "../../i18n/shell";
import { createAvatarElement } from "./avatar";
import type { CardSession } from "./selfProfileTypes";

export interface OwnIdentity {
  id: number | null;
  username: string;
  displayName: string | null;
}

export function ownIdentity(): OwnIdentity {
  const user = authStore.getState().user;
  return {
    id: user?.id ?? null,
    username: user?.username ?? shellText("common.unknown"),
    displayName: user?.display_name ?? null,
  };
}

export interface HeaderPart {
  readonly element: HTMLElement;
  paintNames(next: OwnIdentity): void;
  paintCustomLine(): void;
  paintClearsLine(): void;
}

export function buildHeader(s: CardSession, identity: OwnIdentity): HeaderPart {
  const header = createElement("div", { class: "spc-header" });
  const avatar = createAvatarElement(
    {
      username: identity.username,
      displayName: identity.displayName,
      avatar: authStore.getState().user?.avatar ?? null,
    },
    { className: "spc-avatar", background: "var(--accent)", animate: "always" },
  );
  const names = createElement("div", { class: "spc-names" });
  const nameEl = createElement(
    "div",
    { class: "spc-name", "data-testid": "spc-name" },
    resolveDisplayName(identity),
  );
  const usernameEl = createElement(
    "div",
    { class: "spc-username", "data-testid": "spc-username" },
    identity.username,
  );
  const customLineEl = createElement("div", {
    class: "spc-custom-line",
    "data-testid": "spc-custom-line",
  });
  const clearsLineEl = createElement("div", {
    class: "spc-clears-line",
    "data-testid": "spc-clears-line",
  });
  appendChildren(names, nameEl, usernameEl, customLineEl, clearsLineEl);
  appendChildren(header, avatar, names);

  /** The username line only adds something when a display name is set. */
  function paintNames(next: OwnIdentity): void {
    const shown = resolveDisplayName(next);
    setText(nameEl, shown);
    setText(usernameEl, next.username);
    usernameEl.hidden = shown === next.username;
  }

  function paintCustomLine(): void {
    setText(customLineEl, s.lastCommittedCustom);
    customLineEl.hidden = s.lastCommittedCustom === "";
  }

  /** "Clears at 3:40 PM" while the server will still clear the text; nothing
   *  once the instant has passed (the server's own clear is on its way). */
  function paintClearsLine(): void {
    const iso = s.options.getCustomStatusExpiresAt();
    const at = parseExpiry(iso);
    const live = iso !== null && at !== null && at > Date.now() && s.lastCommittedCustom !== "";
    clearsLineEl.hidden = !live;
    setText(clearsLineEl, live ? customStatusClearsLine(iso) : "");
  }

  paintNames(identity);
  paintCustomLine();
  paintClearsLine();
  return { element: header, paintNames, paintCustomLine, paintClearsLine };
}
