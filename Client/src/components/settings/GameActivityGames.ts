/**
 * Settings > Advanced > Activity > "Your games" (WP 8.3d): every game this
 * device has detected or the user added, with rename, "Show to others" and
 * remove, and the "Add a game" picker over the programs running now.
 *
 * Everything here is a device-local choice (`@lib/gameActivityPrefs`); the loop
 * in `@lib/gameActivity` reads it on its next scan, and hiding the game being
 * shown clears it at once. The list of running programs is read only when the
 * picker opens, is shown only here and is never stored or sent.
 */

import { appendChildren, clearChildren, createElement, setText } from "@lib/dom";
import { isImeCommit } from "@lib/ime";
import { createIcon } from "@lib/icons";
import {
  MAX_GAME_NAME_CHARS,
  cleanGameName,
  displayName,
  gameKey,
  isHidden,
  loadGamePrefs,
  loadSeen,
  pathKey,
  saveGamePrefs,
  withHidden,
  withManual,
  withRename,
  withoutManual,
} from "@lib/gameActivityPrefs";
import { desktop } from "../../platform/desktop";
import type { RunningProgram } from "../../platform/contracts/gameDetector";
import { gameActivityText as t } from "../../i18n/gameActivity";
import { createToggle } from "./helpers";

/** One row of the list. `path` is set for a program the user added. */
interface GameRow {
  readonly name: string;
  readonly path: string | null;
}

/** The rows: programs added by hand, then detected games newest first, then any
 *  hidden name nothing else lists (so it can still be shown again). */
function gameRows(): GameRow[] {
  const prefs = loadGamePrefs();
  const rows: GameRow[] = prefs.manual.map((m) => ({ name: m.name, path: m.path }));
  const keys = new Set(rows.map((r) => gameKey(r.name)));
  for (const name of [...loadSeen(), ...prefs.hidden]) {
    if (keys.has(gameKey(name))) continue;
    keys.add(gameKey(name));
    rows.push({ name, path: null });
  }
  return rows;
}

/** What the list is drawn from, to redraw only when it changed. */
function snapshot(): string {
  return JSON.stringify([loadGamePrefs(), loadSeen()]);
}

/** The section's elements, to append after the sharing row. */
export function buildGamesSection(signal: AbortSignal): HTMLElement[] {
  const title = createElement("div", { class: "setting-label game-list-title" }, t("games.title"));
  const desc = createElement("div", { class: "setting-desc" }, t("games.desc"));
  const list = createElement("div", { "data-testid": "game-activity-games" });
  const addBar = createElement("div", { class: "setting-row" });
  const picker = createElement("div", { class: "game-picker", "data-testid": "game-picker" });
  picker.hidden = true;

  /** The key of the row being renamed. While set, outside changes do not redraw
   *  the list, so a game detected meanwhile cannot wipe what is being typed. */
  let editing: string | null = null;
  /** Counts picker opens; a list that answers for an earlier one is dropped. */
  let pickerRun = 0;

  // -- the list ------------------------------------------------------------------

  /** What the list was last drawn from, to redraw only when it changed. */
  let drawn = "";

  /** Put focus back on a row's rename button (the row was just redrawn). */
  function focusRename(key: string): void {
    for (const row of list.querySelectorAll<HTMLElement>("[data-game-key]")) {
      if (row.dataset.gameKey === key) {
        row.querySelector<HTMLElement>('[data-testid="game-rename"]')?.focus();
        return;
      }
    }
  }

  function renderList(): void {
    drawn = snapshot();
    clearChildren(list);
    const rows = gameRows();
    if (rows.length === 0) {
      list.appendChild(
        createElement(
          "div",
          { class: "setting-desc", "data-testid": "game-activity-games-empty" },
          t("games.empty"),
        ),
      );
      return;
    }
    for (const row of rows) list.appendChild(buildRow(row));
  }

  function buildRow(game: GameRow): HTMLElement {
    const prefs = loadGamePrefs();
    const shown = displayName(prefs, game.name);
    const key = gameKey(game.name);
    const row = createElement("div", { class: "setting-row", "data-testid": "game-row" });
    row.dataset.gameKey = key;
    const info = createElement("div", { class: "game-row-info" });

    if (editing === key) {
      info.appendChild(buildRenameInput(game, shown));
    } else {
      appendChildren(
        info,
        createElement("div", { class: "setting-label", "data-testid": "game-row-name" }, shown),
      );
      const note =
        shown !== game.name
          ? t("games.detectedAs", { game: game.name })
          : game.path !== null
            ? t("games.addedByYou")
            : "";
      if (note !== "") {
        info.appendChild(
          createElement("div", { class: "setting-desc", "data-testid": "game-row-note" }, note),
        );
      }
    }

    const actions = createElement("div", { class: "game-row-actions" });
    const rename = createElement("button", {
      type: "button",
      class: "keybind-mini-btn",
      "aria-label": t("games.rename.aria", { game: shown }),
      title: t("games.rename.aria", { game: shown }),
      "data-testid": "game-rename",
    });
    rename.appendChild(createIcon("pencil", 12));
    rename.addEventListener(
      "click",
      () => {
        editing = editing === key ? null : key;
        renderList();
      },
      { signal },
    );
    actions.appendChild(rename);

    actions.appendChild(
      createToggle(!isHidden(prefs, game.name), {
        signal,
        label: t("games.show.aria", { game: shown }),
        onChange: (nowOn) => {
          saveGamePrefs(withHidden(loadGamePrefs(), game.name, !nowOn));
        },
      }),
    );

    const path = game.path;
    if (path !== null) {
      const remove = createElement("button", {
        type: "button",
        class: "keybind-mini-btn",
        "aria-label": t("games.remove.aria", { game: shown }),
        title: t("games.remove.aria", { game: shown }),
        "data-testid": "game-remove",
      });
      remove.appendChild(createIcon("trash-2", 12));
      remove.addEventListener(
        "click",
        () => {
          editing = null;
          saveGamePrefs(withoutManual(loadGamePrefs(), path, loadSeen()));
          renderList();
          // The row is gone; the nearest stable control takes focus.
          addButton.focus();
        },
        { signal },
      );
      actions.appendChild(remove);
    }
    appendChildren(row, info, actions);
    return row;
  }

  function buildRenameInput(game: GameRow, shown: string): HTMLInputElement {
    const input = createElement("input", {
      type: "text",
      class: "form-input",
      maxlength: String(MAX_GAME_NAME_CHARS),
      "aria-label": t("games.rename.input", { game: game.name }),
      title: t("games.rename.hint"),
      "data-testid": "game-rename-input",
    });
    input.value = shown;
    input.addEventListener(
      "keydown",
      (e) => {
        if (isImeCommit(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          // A blank or invalid name resets to the detected one.
          saveGamePrefs(withRename(loadGamePrefs(), game.name, input.value));
          editing = null;
          renderList();
          focusRename(gameKey(game.name));
        } else if (e.key === "Escape" && !isImeCommit(e)) {
          e.preventDefault();
          // The settings overlay closes on Escape; this one only ends the edit.
          e.stopPropagation();
          editing = null;
          renderList();
          focusRename(gameKey(game.name));
        }
      },
      { signal },
    );
    // Focus once the row is in the page.
    queueMicrotask(() => {
      if (!signal.aborted) {
        input.focus();
        input.select();
      }
    });
    return input;
  }

  // -- the picker ------------------------------------------------------------------

  function closePicker(): void {
    pickerRun += 1;
    picker.hidden = true;
    clearChildren(picker);
    // Whatever closed the picker was inside it and is gone.
    addButton.focus();
  }

  function openPicker(): void {
    const run = ++pickerRun;
    picker.hidden = false;
    clearChildren(picker);
    appendChildren(
      picker,
      createElement("div", { class: "setting-label" }, t("add.title")),
      createElement("div", { class: "setting-desc" }, t("add.desc")),
    );
    const body = createElement("div", { "data-testid": "game-picker-body" });
    body.appendChild(
      createElement("div", { class: "setting-desc", role: "status" }, t("add.loading")),
    );
    picker.appendChild(body);
    void desktop.gameDetector.listRunningPrograms().then((programs) => {
      if (run !== pickerRun || signal.aborted) return;
      showPrograms(body, programs);
    });
  }

  function showPrograms(body: HTMLElement, programs: readonly RunningProgram[]): void {
    clearChildren(body);
    const added = new Set(loadGamePrefs().manual.map((m) => pathKey(m.path)));
    const available = programs.filter((p) => !added.has(pathKey(p.path)));
    if (available.length === 0) {
      body.appendChild(
        createElement(
          "div",
          { class: "setting-desc", "data-testid": "game-picker-empty", role: "status" },
          t("add.empty"),
        ),
      );
      body.appendChild(buildCancel());
      return;
    }
    const filter = createElement("input", {
      type: "text",
      class: "form-input",
      "aria-label": t("add.filter"),
      placeholder: t("add.filter"),
      "data-testid": "game-picker-filter",
    });
    const items = createElement("div", {
      class: "game-picker-list",
      "data-testid": "game-picker-list",
    });
    function paint(): void {
      clearChildren(items);
      const needle = filter.value.trim().toLowerCase();
      const shown = available.filter(
        (p) =>
          needle === "" ||
          p.name.toLowerCase().includes(needle) ||
          p.path.toLowerCase().includes(needle),
      );
      if (shown.length === 0) {
        items.appendChild(createElement("div", { class: "setting-desc" }, t("add.noMatch")));
        return;
      }
      for (const program of shown) {
        const item = createElement("button", {
          type: "button",
          class: "game-picker-item",
          "data-testid": "game-picker-item",
        });
        appendChildren(
          item,
          createElement("span", { class: "setting-label" }, program.name),
          createElement("span", { class: "setting-desc" }, program.path),
        );
        item.addEventListener("click", () => showNameStep(body, program), { signal });
        items.appendChild(item);
      }
    }
    filter.addEventListener("input", paint, { signal });
    filter.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && !isImeCommit(e)) {
          e.preventDefault();
          e.stopPropagation();
          closePicker();
        }
      },
      { signal },
    );
    appendChildren(body, filter, items, buildCancel());
    paint();
    queueMicrotask(() => {
      if (!signal.aborted) filter.focus();
    });
  }

  function showNameStep(body: HTMLElement, program: RunningProgram): void {
    clearChildren(body);
    const input = createElement("input", {
      type: "text",
      class: "form-input",
      maxlength: String(MAX_GAME_NAME_CHARS),
      "aria-label": t("add.name", { program: program.name }),
      "data-testid": "game-picker-name",
    });
    input.value = program.name;
    const error = createElement("div", {
      class: "keybind-alert",
      role: "alert",
      "data-testid": "game-picker-error",
    });
    error.hidden = true;

    function save(): void {
      const name = cleanGameName(input.value);
      const next = name === null ? null : withManual(loadGamePrefs(), program.path, name);
      if (next === null) {
        setText(error, t("add.nameInvalid"));
        error.hidden = false;
        return;
      }
      saveGamePrefs(next);
      closePicker();
      renderList();
    }

    input.addEventListener(
      "keydown",
      (e) => {
        if (isImeCommit(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          save();
        } else if (e.key === "Escape" && !isImeCommit(e)) {
          e.preventDefault();
          e.stopPropagation();
          closePicker();
        }
      },
      { signal },
    );
    const saveBtn = createElement(
      "button",
      { type: "button", class: "ac-btn", "data-testid": "game-picker-save" },
      t("add.save"),
    );
    saveBtn.addEventListener("click", save, { signal });
    const actions = createElement("div", { class: "game-row-actions" });
    appendChildren(actions, buildCancel(), saveBtn);
    appendChildren(
      body,
      createElement("div", { class: "setting-desc" }, program.path),
      input,
      error,
      actions,
    );
    queueMicrotask(() => {
      if (!signal.aborted) {
        input.focus();
        input.select();
      }
    });
  }

  function buildCancel(): HTMLButtonElement {
    const cancel = createElement(
      "button",
      { type: "button", class: "ac-btn secondary", "data-testid": "game-picker-cancel" },
      t("add.cancel"),
    );
    cancel.addEventListener("click", closePicker, { signal });
    return cancel;
  }

  // -- wiring ------------------------------------------------------------------------

  const addButton = createElement(
    "button",
    { type: "button", class: "ac-btn secondary", "data-testid": "game-add" },
    t("add.button"),
  );
  addButton.addEventListener("click", () => (picker.hidden ? openPicker() : closePicker()), {
    signal,
  });
  addBar.appendChild(addButton);

  // A game detected while the pane is open shows when the pointer comes to
  // the list, and only if something changed: a redraw would drop the focus of
  // a keyboard user, so focus moving through the list never redraws it.
  list.addEventListener(
    "pointerenter",
    () => {
      if (editing === null && snapshot() !== drawn) renderList();
    },
    { signal },
  );

  renderList();
  return [title, desc, list, addBar, picker];
}
