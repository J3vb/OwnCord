/**
 * "Direct messages" at the top of the Settings Safety tab: the two
 * per-member switches the server stores and enforces, "Allow direct messages
 * from server members" and "Message requests". Loaded on first open
 * (reports/safetyPane.ts) and only on a server with `dm_privacy`.
 *
 * The server owns the values: there is no store and no localStorage. A GET
 * fills the section, and every change sends a PUT with both values. A switch
 * flips at once, but the flip is only a preview: a failed PUT puts the switch
 * back to the server's value (re-read, else the last reply) and says so. Only
 * one PUT is in flight: clicks meanwhile just update the switches, and when
 * the request settles the latest full object is sent, so the last click wins
 * and no reply can overwrite a newer click. The tab's
 * signal tears everything down, and no DOM is touched afterwards.
 */

import type { ApiClient, DmPrivacy } from "@lib/api";
import { createElement, setText } from "@lib/dom";
import { createLogger } from "@lib/logger";
import { safetyText as t } from "../../i18n/safety";

const log = createLogger("DmPrivacy");

export type DmPrivacyApi = Pick<ApiClient, "getDmPrivacy" | "putDmPrivacy">;

let sectionSeq = 0;

export function buildDmPrivacySection(signal: AbortSignal, api: DmPrivacyApi): HTMLElement {
  const seq = ++sectionSeq;
  const titleId = `dm-privacy-${seq}`;
  const section = createElement("section", {
    class: "dm-privacy",
    "aria-labelledby": titleId,
    "data-testid": "dm-privacy",
  });
  const heading = createElement(
    "h3",
    { class: "safety-heading", id: titleId, tabindex: "-1" },
    t("dmPrivacy.title"),
  );
  const desc = createElement("p", { class: "setting-desc" }, t("dmPrivacy.desc"));
  // Both live regions exist before their text changes, so each change is read.
  const status = createElement("div", { class: "my-reports-status", role: "status" });
  const failure = createElement("div", {
    class: "form-error",
    role: "alert",
    "data-testid": "dm-privacy-error",
  });
  const retry = createElement(
    "button",
    { type: "button", class: "ac-btn secondary", "data-testid": "dm-privacy-retry" },
    t("dmPrivacy.retry"),
  );
  retry.hidden = true;
  const rowsEl = createElement("div", { class: "dm-privacy-rows" });
  section.append(heading, desc, status, failure, retry, rowsEl);

  /** The last values the server confirmed (GET or a PUT reply). */
  let confirmed: DmPrivacy | null = null;
  /** What the switches show: `confirmed` plus a change still in flight. */
  let shown: DmPrivacy | null = null;
  /** One PUT (or the re-GET after a failed one) at a time. */
  let busy = false;
  /** A click landed after the last PUT was sent: `shown` is newer than it. */
  let dirty = false;

  function makeRow(
    key: keyof DmPrivacy,
    id: string,
    label: string,
    help: string,
  ): { row: HTMLElement; sync: () => void } {
    const labelId = `${id}-label`;
    const descId = `${id}-desc`;
    const hintId = `${id}-hint`;
    const row = createElement("div", { class: "setting-row", "data-testid": `${id}-row` });
    const info = createElement("div", {});
    info.append(
      createElement("div", { class: "setting-label", id: labelId }, label),
      createElement("div", { class: "setting-desc", id: descId }, help),
    );
    const hint = createElement(
      "div",
      { class: "setting-desc", id: hintId, "data-testid": `${id}-hint` },
      t("dmPrivacy.requests.disabledHint"),
    );
    hint.hidden = true;
    info.appendChild(hint);
    const toggle = createElement("div", {
      class: "toggle",
      role: "switch",
      tabindex: "0",
      "aria-checked": "false",
      "aria-labelledby": labelId,
      "aria-describedby": `${descId} ${hintId}`,
      "data-testid": id,
    });
    function activate(): void {
      if (shown === null || toggle.getAttribute("aria-disabled") === "true") return;
      change({ ...shown, [key]: !shown[key] });
    }
    toggle.addEventListener("click", activate, { signal });
    toggle.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        activate();
      },
      { signal },
    );
    row.append(info, toggle);
    return {
      row,
      sync() {
        if (shown === null) return;
        const on = shown[key];
        toggle.classList.toggle("on", on);
        toggle.setAttribute("aria-checked", String(on));
        // "Message requests" has no meaning while direct messages are off.
        const off = key === "message_requests" && !shown.allow_member_dms;
        if (off) toggle.setAttribute("aria-disabled", "true");
        else toggle.removeAttribute("aria-disabled");
        hint.hidden = !off;
      },
    };
  }

  const allow = makeRow(
    "allow_member_dms",
    `dm-privacy-allow-${seq}`,
    t("dmPrivacy.allow.label"),
    t("dmPrivacy.allow.desc"),
  );
  const requests = makeRow(
    "message_requests",
    `dm-privacy-requests-${seq}`,
    t("dmPrivacy.requests.label"),
    t("dmPrivacy.requests.desc"),
  );

  function render(): void {
    if (signal.aborted) return;
    allow.sync();
    requests.sync();
  }

  function change(next: DmPrivacy): void {
    setText(failure, "");
    shown = next;
    dirty = true;
    render();
    // Last click wins without overlapping requests: while one is in flight the
    // click only updates `shown`, and the settle step sends the latest object.
    if (!busy) send();
  }

  /** Send `shown` whole; on settle send again if the user changed it meanwhile. */
  function send(): void {
    if (shown === null) return;
    busy = true;
    dirty = false;
    api.putDmPrivacy(shown, signal).then(
      (stored) => {
        busy = false;
        if (signal.aborted) return;
        confirmed = stored;
        if (dirty) send();
        else {
          shown = stored;
          render();
        }
      },
      (err: unknown) => {
        if (signal.aborted) {
          busy = false;
          return;
        }
        if (dirty) {
          // An earlier PUT failed but a newer object is waiting: it is the one
          // the user wants, so it gets its turn.
          busy = false;
          send();
          return;
        }
        log.warn("Failed to save direct message settings", { error: String(err) });
        setText(failure, t("dmPrivacy.saveFailed"));
        resync();
      },
    );
  }

  /** After a failed save: ask the server what it holds (an earlier PUT may have landed). */
  function resync(): void {
    api.getDmPrivacy(signal).then(
      (r) => {
        busy = false;
        if (signal.aborted) return;
        confirmed = r;
        if (dirty) send();
        else {
          shown = r;
          render();
        }
      },
      () => {
        busy = false;
        if (signal.aborted) return;
        // No optimistic state is kept: back to what the server last confirmed.
        if (dirty) send();
        else {
          shown = confirmed;
          render();
        }
      },
    );
  }

  function load(): void {
    setText(failure, "");
    setText(status, t("dmPrivacy.loading"));
    retry.setAttribute("aria-disabled", "true");
    section.setAttribute("aria-busy", "true");
    api.getDmPrivacy(signal).then(
      (r) => {
        if (signal.aborted) return;
        confirmed = r;
        shown = r;
        setText(status, "");
        retry.hidden = true;
        const retryHadFocus = document.activeElement === retry;
        section.removeAttribute("aria-busy");
        if (rowsEl.children.length === 0) rowsEl.append(allow.row, requests.row);
        render();
        if (retryHadFocus) heading.focus();
      },
      (err: unknown) => {
        if (signal.aborted) return;
        log.warn("Failed to load direct message settings", { error: String(err) });
        setText(status, "");
        section.removeAttribute("aria-busy");
        retry.removeAttribute("aria-disabled");
        retry.hidden = false;
        setText(failure, t("dmPrivacy.loadFailed"));
      },
    );
  }

  retry.addEventListener(
    "click",
    () => {
      if (retry.getAttribute("aria-disabled") === "true") return;
      load();
    },
    { signal },
  );
  // A tab closed before this module loaded gets nothing: no GET.
  if (!signal.aborted) load();
  return section;
}
