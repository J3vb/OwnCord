/**
 * MusicPicker — the "pick an app" dialog of Share music. Lists the apps with
 * sound on this machine (playing ones first) with icon and name, a Refresh
 * and Share. Nothing is captured until the caller starts the share with the
 * app this resolves with.
 *
 * Built on `createModal`, like the screen-share picker, so it carries the
 * shared dialog contract (role, modal, focus trap, Escape, focus restore).
 * All copy lives in the `voice` catalog.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { createModal, type ModalInstance } from "@lib/ui/modalFactory";
import { desktop } from "../../platform/desktop";
import type { AudioApp } from "../../platform/contracts/musicAudio";
import { voiceText as t } from "../../i18n/voice";

/** Playing apps first, then by name; the host sorts too, but the page does
 *  not rely on it. */
export function sortAudioApps(apps: readonly AudioApp[]): AudioApp[] {
  return apps.toSorted(
    (a, b) =>
      Number(b.playing) - Number(a.playing) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/** Resolve the app to share, or null when the user closed the dialog. */
export function showMusicPicker(): Promise<AudioApp | null> {
  return new Promise((resolve) => {
    let picked: AudioApp | null = null;
    let selected: AudioApp | null = null;
    let apps: AudioApp[] = [];
    /** Bumped per listing, so only the latest answer draws. */
    let request = 0;

    const content = createElement("div", { class: "screen-share-picker music-picker" });
    const header = createElement("div", { class: "modal-header" });
    header.appendChild(createElement("h3", { id: "music-picker-title" }, t("music.picker.title")));
    content.appendChild(header);

    const body = createElement("div", { class: "modal-body" });
    body.appendChild(createElement("p", { class: "ssp-hint" }, t("music.picker.hint")));
    const list = createElement("div", {
      class: "music-picker__list",
      role: "radiogroup",
      "aria-label": t("music.picker.listLabel"),
      "aria-busy": "true",
    });
    const status = createElement("p", {
      class: "ssp-empty",
      role: "status",
      "data-testid": "music-picker-status",
    });
    appendChildren(body, list, status);
    content.appendChild(body);

    const footer = createElement("div", { class: "modal-footer" });
    const refresh = createElement(
      "button",
      { class: "btn-modal-cancel", type: "button", "data-testid": "music-picker-refresh" },
      t("music.picker.refresh"),
    );
    const cancel = createElement(
      "button",
      { class: "btn-modal-cancel", type: "button" },
      t("music.picker.cancel"),
    );
    const share = createElement("button", {
      class: "btn-modal-save",
      type: "button",
      "data-testid": "music-picker-share",
    });
    share.appendChild(createIcon("music", 16));
    share.appendChild(document.createTextNode(t("music.picker.share")));
    share.disabled = true;
    appendChildren(footer, refresh, cancel, share);
    content.appendChild(footer);

    function select(app: AudioApp): void {
      selected = app;
      for (const row of list.querySelectorAll<HTMLButtonElement>(".music-picker__app")) {
        const on = row.dataset["appId"] === app.id;
        row.setAttribute("aria-checked", String(on));
        row.tabIndex = on ? 0 : -1;
      }
      share.disabled = false;
    }

    function appRow(app: AudioApp): HTMLButtonElement {
      const row = createElement("button", {
        class: "music-picker__app",
        type: "button",
        role: "radio",
        "aria-checked": "false",
        tabindex: "-1",
        "data-app-id": app.id,
        "aria-label": t("music.picker.appLabel", { name: app.name }),
      });
      const icon = createElement("span", { class: "music-picker__icon", "aria-hidden": "true" });
      if (app.icon !== null) icon.appendChild(createElement("img", { src: app.icon, alt: "" }));
      else icon.appendChild(createIcon("music", 18));
      const badge = createElement(
        "span",
        {
          class: app.playing
            ? "music-picker__state music-picker__state--on"
            : "music-picker__state",
        },
        t(app.playing ? "music.picker.playing" : "music.picker.quiet"),
      );
      appendChildren(row, icon, createElement("span", { class: "ssp-title" }, app.name), badge);
      row.addEventListener("click", () => select(app));
      return row;
    }

    function draw(): void {
      list.replaceChildren(...apps.map(appRow));
      list.setAttribute("aria-busy", "false");
      const keep = apps.find((a) => a.id === selected?.id) ?? null;
      selected = null;
      share.disabled = true;
      if (keep !== null) select(keep);
      else if (apps[0] !== undefined) select(apps[0]);
      setText(status, apps.length === 0 ? t("music.picker.empty") : "");
    }

    function load(): void {
      const mine = ++request;
      list.setAttribute("aria-busy", "true");
      setText(status, t("music.picker.loading"));
      void desktop.musicAudio.listApps().then((answer) => {
        if (mine !== request) return;
        if (!answer.ok) {
          apps = [];
          draw();
          setText(status, t("music.picker.loadFailed"));
          return;
        }
        apps = sortAudioApps(answer.apps);
        draw();
      });
    }

    list.addEventListener("keydown", (e: KeyboardEvent) => {
      // i18n-exempt: KeyboardEvent.key values, wire identifiers, never displayed
      if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
      const rows = [...list.querySelectorAll<HTMLButtonElement>(".music-picker__app")];
      if (rows.length === 0) return;
      e.preventDefault();
      const current = rows.findIndex((r) => r.getAttribute("aria-checked") === "true");
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next = rows[(current + step + rows.length) % rows.length];
      next?.click();
      next?.focus();
    });

    let modal: ModalInstance | null = null;
    const close = (): void => modal?.close();
    refresh.addEventListener("click", load);
    cancel.addEventListener("click", close);
    share.addEventListener("click", () => {
      if (selected === null) return;
      picked = selected;
      close();
    });

    modal = createModal({
      content,
      ariaLabelledBy: "music-picker-title",
      overlayAttrs: { "data-testid": "music-picker" },
      onClose: () => {
        request++;
        resolve(picked);
      },
    });
    modal.modal.style.width = "min(480px, 92vw)";
    load();
    share.focus();
  });
}
