/**
 * Appearance > Custom Themes: the saved list of the user's own CSS themes,
 * with an editor, import and export. The rules and the painting are in
 * lib/customTheme.ts; this file only keeps the list on screen in step.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { copyThenToast } from "@lib/clipboard";
import { createLogger } from "@lib/logger";
import { showToast } from "@lib/toast";
import {
  MAX_CUSTOM_THEMES,
  MAX_THEME_CSS_CHARS,
  MAX_THEME_NAME_CHARS,
  checkThemeCss,
  cleanThemeName,
  getActiveCustomThemeId,
  loadCustomThemes,
  newCustomThemeId,
  onCustomThemeChange,
  saveCustomThemes,
  setActiveCustomTheme,
  type CustomTheme,
  type ThemeCssProblem,
} from "@lib/customTheme";
import { createConfirmModal } from "../../features/dialogs/confirmModal";
import { desktop } from "../../platform/desktop";
import { settingsText as t } from "../../i18n/settings";

const log = createLogger("custom-theme");

export function problemText(problem: ThemeCssProblem): string {
  if (problem.kind === "tooBig") {
    return t("appearance.customThemes.tooBig", { limit: MAX_THEME_CSS_CHARS.toLocaleString() });
  }
  return problem.line === null
    ? t("appearance.customThemes.outsideLinkNoLine", { found: problem.found })
    : t("appearance.customThemes.outsideLink", { found: problem.found, line: problem.line });
}

/** A file name for `name`: letters, digits and dashes, never empty. */
export function themeFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // i18n-exempt: a filename, not UI text
  return `${slug === "" ? "theme" : slug}.css`;
}

/** The theme name an imported file suggests: its name without the extension. */
function nameFromFile(fileName: string): string {
  const clean = cleanThemeName(fileName.replace(/\.css$/i, ""));
  return clean === "" ? t("appearance.customThemes.untitled") : clean;
}

function button(
  label: string,
  aria: string,
  onClick: () => void,
  signal: AbortSignal,
): HTMLButtonElement {
  const btn = createElement(
    "button",
    { class: "ac-btn secondary", type: "button", "aria-label": aria },
    label,
  );
  btn.addEventListener("click", onClick, { signal });
  return btn;
}

function toggleUse(theme: CustomTheme, active: boolean): void {
  if (active) {
    setActiveCustomTheme(null);
  } else if (!setActiveCustomTheme(theme.id)) {
    showToast(t("appearance.customThemes.applyFailed"), "error");
  }
}

async function exportTheme(theme: CustomTheme): Promise<void> {
  try {
    const path = await desktop.fileSaver.pickSaveLocation(themeFileName(theme.name));
    if (path === null) return;
    await desktop.fileSaver.writeFile(path, new TextEncoder().encode(theme.css));
  } catch (err) {
    log.error("Export custom theme failed", { error: String(err) });
    showToast(t("appearance.customThemes.exportFailed"), "error");
  }
}

export function buildCustomThemeSection(signal: AbortSignal): HTMLElement {
  const section = createElement("div", { class: "custom-themes" });
  const header = createElement("h3", {}, t("appearance.customThemes"));
  const desc = createElement("p", { class: "setting-desc" }, t("appearance.customThemes.desc"));
  const list = createElement("ul", { class: "custom-theme-list" });
  const actions = createElement("div", { class: "custom-theme-actions" });
  const newBtn = createElement(
    "button",
    { class: "ac-btn secondary", type: "button" },
    t("appearance.customThemes.new"),
  );
  const importBtn = createElement(
    "button",
    { class: "ac-btn secondary", type: "button" },
    t("appearance.customThemes.import"),
  );
  const fileInput = createElement("input", {
    type: "file",
    accept: ".css,text/css",
    hidden: "",
    "data-testid": "custom-theme-file",
  });
  appendChildren(actions, newBtn, importBtn, fileInput);

  // The editor: one form for both a new theme and an edit.
  const editor = createElement("div", { class: "custom-theme-editor", hidden: "" });
  const nameLabel = createElement(
    "label",
    { class: "custom-theme-label" },
    t("appearance.customThemes.name"),
  );
  const nameInput = createElement("input", {
    class: "form-input",
    type: "text",
    maxlength: String(MAX_THEME_NAME_CHARS),
    "data-testid": "custom-theme-name",
  });
  nameLabel.appendChild(nameInput);
  const cssLabel = createElement(
    "label",
    { class: "custom-theme-label" },
    t("appearance.customThemes.css"),
  );
  const cssInput = createElement("textarea", {
    class: "form-input custom-theme-css",
    rows: "12",
    spellcheck: "false",
    maxlength: String(MAX_THEME_CSS_CHARS),
    "data-testid": "custom-theme-css",
  });
  cssLabel.appendChild(cssInput);
  const error = createElement("p", {
    class: "custom-theme-error",
    role: "alert",
    "data-testid": "custom-theme-error",
  });
  const editorButtons = createElement("div", { class: "custom-theme-actions" });
  const saveBtn = createElement(
    "button",
    { class: "ac-btn", type: "button", "data-testid": "custom-theme-save" },
    t("appearance.customThemes.save"),
  );
  const cancelBtn = createElement(
    "button",
    { class: "ac-btn secondary", type: "button" },
    t("appearance.customThemes.cancel"),
  );
  appendChildren(editorButtons, saveBtn, cancelBtn);
  appendChildren(editor, nameLabel, cssLabel, error, editorButtons);

  /** The id being edited; null for a new theme. */
  let editing: string | null = null;

  function openEditor(theme: CustomTheme | null): void {
    editing = theme?.id ?? null;
    nameInput.value = theme?.name ?? "";
    cssInput.value = theme?.css ?? "";
    setText(error, "");
    editor.hidden = false;
    nameInput.focus();
  }

  function closeEditor(): void {
    editing = null;
    editor.hidden = true;
    newBtn.focus();
  }

  function save(): void {
    const name = cleanThemeName(nameInput.value);
    if (name === "") {
      setText(error, t("appearance.customThemes.nameMissing"));
      return;
    }
    const css = cssInput.value;
    const problem = checkThemeCss(css);
    if (problem !== null) {
      setText(error, problemText(problem));
      return;
    }
    const themes = loadCustomThemes();
    const id = editing ?? newCustomThemeId();
    const at = themes.findIndex((theme) => theme.id === id);
    if (at === -1 && themes.length >= MAX_CUSTOM_THEMES) {
      setText(error, t("appearance.customThemes.full", { limit: MAX_CUSTOM_THEMES }));
      return;
    }
    const next = at === -1 ? [...themes, { id, name, css }] : themes.with(at, { id, name, css });
    if (!saveCustomThemes(next)) {
      setText(error, t("appearance.customThemes.saveFailed"));
      return;
    }
    if (getActiveCustomThemeId() === id) setActiveCustomTheme(id);
    closeEditor();
    render();
  }

  function remove(theme: CustomTheme): void {
    createConfirmModal({
      title: t("appearance.customThemes.deleteTitle", { name: theme.name }),
      body: t("appearance.customThemes.deleteBody"),
      confirmLabel: t("appearance.customThemes.delete"),
      cancelLabel: t("appearance.customThemes.cancel"),
      testId: "custom-theme-delete-dialog",
      confirmTestId: "custom-theme-delete-confirm",
      signal,
      onConfirm: () => {
        saveCustomThemes(loadCustomThemes().filter((other) => other.id !== theme.id));
        if (getActiveCustomThemeId() === theme.id) setActiveCustomTheme(null);
        if (editing === theme.id) closeEditor();
        render();
      },
    });
  }

  function render(): void {
    const themes = loadCustomThemes();
    const activeId = getActiveCustomThemeId();
    list.replaceChildren();
    if (themes.length === 0) {
      list.appendChild(
        createElement("li", { class: "custom-theme-empty" }, t("appearance.customThemes.empty")),
      );
    }
    for (const theme of themes) {
      const active = theme.id === activeId;
      const row = createElement("li", {
        class: `custom-theme-row${active ? " active" : ""}`,
        "data-testid": "custom-theme-row",
      });
      const name = createElement("span", { class: "custom-theme-name" }, theme.name);
      row.appendChild(name);
      if (active) {
        row.appendChild(
          createElement(
            "span",
            { class: "custom-theme-badge" },
            t("appearance.customThemes.inUse"),
          ),
        );
      }
      const use = button(
        active ? t("appearance.customThemes.turnOff") : t("appearance.customThemes.use"),
        active
          ? t("appearance.customThemes.turnOff")
          : t("appearance.customThemes.useAria", { name: theme.name }),
        () => toggleUse(theme, active),
        signal,
      );
      use.setAttribute("aria-pressed", active ? "true" : "false");
      appendChildren(
        row,
        use,
        button(
          t("appearance.customThemes.edit"),
          t("appearance.customThemes.editAria", { name: theme.name }),
          () => openEditor(theme),
          signal,
        ),
        button(
          t("appearance.customThemes.copy"),
          t("appearance.customThemes.copyAria", { name: theme.name }),
          () =>
            copyThenToast(
              theme.css,
              t("appearance.customThemes.copied"),
              t("appearance.customThemes.copyFailed"),
            ),
          signal,
        ),
        button(
          t("appearance.customThemes.export"),
          t("appearance.customThemes.exportAria", { name: theme.name }),
          () => void exportTheme(theme),
          signal,
        ),
        button(
          t("appearance.customThemes.delete"),
          t("appearance.customThemes.deleteAria", { name: theme.name }),
          () => remove(theme),
          signal,
        ),
      );
      list.appendChild(row);
    }
    const full = themes.length >= MAX_CUSTOM_THEMES;
    newBtn.disabled = full;
    importBtn.disabled = full;
  }

  async function importFile(file: File): Promise<void> {
    if (file.size > MAX_THEME_CSS_CHARS * 4) {
      showToast(
        t("appearance.customThemes.tooBig", { limit: MAX_THEME_CSS_CHARS.toLocaleString() }),
        "error",
      );
      return;
    }
    let css: string;
    try {
      css = (await file.text()).replace(/^\ufeff/, "");
    } catch {
      showToast(t("appearance.customThemes.importFailed"), "error");
      return;
    }
    const problem = checkThemeCss(css);
    if (problem !== null) {
      showToast(problemText(problem), "error");
      return;
    }
    const themes = loadCustomThemes();
    if (themes.length >= MAX_CUSTOM_THEMES) {
      showToast(t("appearance.customThemes.full", { limit: MAX_CUSTOM_THEMES }), "error");
      return;
    }
    const name = nameFromFile(file.name);
    if (!saveCustomThemes([...themes, { id: newCustomThemeId(), name, css }])) {
      showToast(t("appearance.customThemes.saveFailed"), "error");
      return;
    }
    showToast(t("appearance.customThemes.imported", { name }), "success");
    render();
  }

  newBtn.addEventListener("click", () => openEditor(null), { signal });
  importBtn.addEventListener("click", () => fileInput.click(), { signal });
  fileInput.addEventListener(
    "change",
    () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (file !== undefined) void importFile(file);
    },
    { signal },
  );
  saveBtn.addEventListener("click", save, { signal });
  cancelBtn.addEventListener("click", closeEditor, { signal });
  // Ctrl+Shift+Backspace, or another settings window, can change the active theme.
  onCustomThemeChange(render, signal);

  render();
  appendChildren(section, header, desc, list, actions, editor);
  return section;
}
