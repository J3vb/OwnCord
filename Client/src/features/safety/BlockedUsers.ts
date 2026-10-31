/**
 * "Blocked users" at the top of the Settings Privacy & Safety tab (3B-7): the
 * people the caller has blocked, each with an Unblock button. Loaded on first
 * open (reports/safetyPane.ts), outside the Settings chunk.
 *
 * The list keeps no copy of its own: blocksStore.blockedByMe is the one source
 * of truth, so a block or unblock made elsewhere (the member list, a profile)
 * shows here live. GET /blocks returns ids only, so each id is named from
 * membersStore, then the DM participants, then an "Unknown user" fallback.
 *
 * Teardown (the tab's signal): the store subscription is dropped, the GET is
 * aborted and no DOM is touched afterwards. A GET answers into the store with
 * the store's revision guard, so a stale reply never overwrites a newer state.
 * An unblock is not aborted with the tab: the user asked for it, so it
 * finishes, writes the store and toasts, but never touches the closed view.
 */

import { errorText, type ApiClient } from "@lib/api";
import { createElement, setText } from "@lib/dom";
import { createLogger } from "@lib/logger";
import { registerSessionReset } from "@lib/net/sessionRegistry";
import { showToast } from "@lib/ui/toast";
import type { createAvatarElement } from "../profiles/avatar";
import { blocksStore, setBlockedByMe, setUserBlockedByMe } from "@stores/blocks.store";
import { dmStore } from "@stores/dm.store";
import { memberDisplayName, membersStore } from "@stores/members.store";
import { blockedUsersText as t } from "../../i18n/blockedUsers";
import { shellText } from "../../i18n/shell";

const log = createLogger("BlockedUsers");

export type BlockedUsersApi = Pick<ApiClient, "listBlocks" | "unblockUser">;
/** The avatar drawer, injected: a feature reaches the UI layer only lazily. */
export type CreateAvatar = typeof createAvatarElement;

interface BlockedIdentity {
  readonly name: string;
  /** "" when the user is not known to this client. */
  readonly username: string;
  readonly avatar: string | null;
}

/** Who a blocked id is: the roster, then DM participants, then unknown. */
export function resolveBlockedUser(userId: number): BlockedIdentity {
  const member = membersStore.getState().members.get(userId);
  if (member !== undefined) {
    return { name: memberDisplayName(member), username: member.username, avatar: member.avatar };
  }
  for (const dm of dmStore.getState().channels) {
    for (const p of [...dm.participants, dm.recipient]) {
      if (p.id !== userId || p.username === "") continue;
      const display = p.displayName ?? "";
      return {
        name: display.trim().length > 0 ? display : p.username,
        username: p.username,
        avatar: p.avatar === "" ? null : p.avatar,
      };
    }
  }
  return { name: t("unknownUser"), username: "", avatar: null };
}

let sectionSeq = 0;

/** Unblocks in flight, shared by every open view: closing and reopening the
 *  tab mid-request must still show that row as busy, not offer a second DELETE. */
const pending = new Set<number>();
/** Live views, re-rendered when `pending` changes. */
const liveViews = new Set<() => void>();
function renderLiveViews(): void {
  for (const render of liveViews) render();
}

/** For tests: forget in-flight unblocks left by an earlier test. */
export function resetPendingUnblocks(): void {
  pending.clear();
}

void registerSessionReset("blocked-users:pending", resetPendingUnblocks, { phase: "cache" }); // app-lifetime

/** Load the avatar drawer lazily, then build the section. */
export async function loadBlockedUsersSection(
  signal: AbortSignal,
  api: BlockedUsersApi,
): Promise<HTMLElement> {
  const { createAvatarElement: createAvatar } = await import("../profiles/avatar");
  return buildBlockedUsersSection(signal, api, createAvatar);
}

export function buildBlockedUsersSection(
  signal: AbortSignal,
  api: BlockedUsersApi,
  createAvatar: CreateAvatar,
): HTMLElement {
  const titleId = `blocked-users-${++sectionSeq}`;
  const section = createElement("section", {
    class: "blocked-users",
    "aria-labelledby": titleId,
    "data-testid": "blocked-users",
  });
  const heading = createElement(
    "h3",
    { class: "safety-heading", id: titleId, tabindex: "-1" },
    t("title"),
  );
  const desc = createElement("p", { class: "setting-desc" }, t("desc"));
  // Both live regions exist before their text changes, so each change is read.
  const status = createElement("div", { class: "my-reports-status", role: "status" });
  const failure = createElement("div", { class: "form-error", role: "alert" });
  const retry = createElement(
    "button",
    { type: "button", class: "ac-btn secondary", "data-testid": "blocked-users-retry" },
    t("retry"),
  );
  retry.hidden = true;
  const list = createElement("ul", { class: "blocked-users-list" });
  section.append(heading, desc, status, failure, retry, list);

  let phase: "loading" | "loaded" | "failed" = "loading";
  const rows = new Map<number, { el: HTMLLIElement; sig: string }>();

  function buildRow(userId: number, who: BlockedIdentity, busy: boolean): HTMLLIElement {
    const li = createElement("li", {
      class: "session-row blocked-user-row",
      "data-testid": "blocked-user-row",
      "data-user-id": String(userId),
    });
    const avatar = createAvatar(
      {
        username: who.username === "" ? "?" : who.username,
        displayName: who.name,
        avatar: who.avatar,
        // An unknown user draws as "?", never as the "U" of "Unknown user".
        isDeleted: who.username === "",
      },
      { className: "blocked-user-avatar" },
    );
    const info = createElement("div", { class: "session-info blocked-user-info" });
    info.appendChild(createElement("div", { class: "session-device" }, who.name));
    if (who.username !== "") {
      info.appendChild(createElement("div", { class: "session-detail" }, `@${who.username}`));
    }
    const button = createElement(
      "button",
      {
        type: "button",
        class: "ac-btn secondary",
        "data-testid": "blocked-user-unblock",
        "aria-label": busy
          ? t("unblockingLabel", { name: who.name })
          : t("unblockLabel", { name: who.name }),
      },
      busy ? t("unblocking") : t("unblock"),
    );
    if (busy) {
      button.setAttribute("aria-busy", "true");
      button.setAttribute("aria-disabled", "true");
    }
    button.addEventListener("click", () => unblock(userId, who.name), { signal });
    li.append(avatar, info, button);
    return li;
  }

  function render(): void {
    if (signal.aborted) return;
    const ids = [...blocksStore.getState().blockedByMe];
    const wanted = new Set(ids);
    for (const [id, row] of rows) {
      if (!wanted.has(id)) {
        row.el.remove();
        rows.delete(id);
      }
    }
    ids.forEach((id, index) => {
      const who = resolveBlockedUser(id);
      const busy = pending.has(id);
      const sig = JSON.stringify([who.name, who.username, who.avatar, busy]);
      let row = rows.get(id);
      if (row === undefined || row.sig !== sig) {
        const hadFocus = row !== undefined && row.el.contains(document.activeElement);
        const el = buildRow(id, who, busy);
        row?.el.replaceWith(el);
        row = { el, sig };
        rows.set(id, row);
        if (hadFocus) el.querySelector("button")?.focus();
      }
      if (list.children[index] !== row.el) list.insertBefore(row.el, list.children[index] ?? null);
    });
    if (phase === "loading") setText(status, ids.length === 0 ? t("loading") : "");
    else setText(status, phase === "loaded" && ids.length === 0 ? t("empty") : "");
  }

  function unblock(userId: number, name: string): void {
    if (pending.has(userId)) return;
    pending.add(userId);
    renderLiveViews();
    // Not tied to the tab's signal: closing Settings must not cancel it.
    api.unblockUser(userId).then(
      () => {
        // The store write re-renders every live view; the row leaves with it.
        const hadFocus = list.contains(document.activeElement);
        const rowsBefore = [...list.children];
        const at = rowsBefore.findIndex((el) => el === rows.get(userId)?.el);
        pending.delete(userId);
        setUserBlockedByMe(userId, false);
        blocksStore.flush();
        showToast(shellText("members.unblocked", { username: name }), "success");
        renderLiveViews();
        if (signal.aborted || !hadFocus || list.contains(document.activeElement)) return;
        // The focused row is gone: land on the next Unblock, else the previous,
        // else the heading.
        const target = list.children[Math.min(at, list.children.length - 1)];
        const next = target?.querySelector<HTMLElement>("button");
        (next ?? heading).focus();
      },
      (err: unknown) => {
        pending.delete(userId);
        const fallback = shellText("members.unblockFailed");
        showToast(errorText(err, fallback) || fallback, "error");
        // The row stays and its button comes back.
        renderLiveViews();
      },
    );
  }

  function load(): void {
    phase = "loading";
    // Retry stays put while loading so a focused button keeps focus.
    retry.setAttribute("aria-disabled", "true");
    section.setAttribute("aria-busy", "true");
    setText(failure, "");
    render();
    // Snapshot before the request: a block or unblock that lands while it is
    // in flight bumps the revision and makes this reply skip itself.
    const rev = blocksStore.getState().blockedByMeRev ?? 0;
    api.listBlocks(signal).then(
      (r) => {
        if (signal.aborted) return;
        setBlockedByMe(r.blocked_user_ids, rev);
        phase = "loaded";
        const retryHadFocus = document.activeElement === retry;
        retry.hidden = true;
        section.removeAttribute("aria-busy");
        render();
        if (retryHadFocus) heading.focus();
      },
      (err: unknown) => {
        if (signal.aborted) return;
        log.warn("Failed to load blocked users", { error: String(err) });
        phase = "failed";
        section.removeAttribute("aria-busy");
        retry.removeAttribute("aria-disabled");
        retry.hidden = false;
        setText(failure, t("loadFailed"));
        render();
      },
    );
  }

  retry.addEventListener(
    "click",
    () => {
      if (phase === "loading") return;
      load();
    },
    { signal },
  );
  // A tab closed before this module loaded gets nothing: no subscription, no GET.
  if (signal.aborted) return section;
  const unsubscribe = blocksStore.subscribeSelector((s) => s.blockedByMe, render);
  liveViews.add(render);
  signal.addEventListener(
    "abort",
    () => {
      unsubscribe();
      liveViews.delete(render);
    },
    { once: true },
  );
  load();
  return section;
}
