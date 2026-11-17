/**
 * The custom theme editor's background picture box: pick a picture, see a
 * preview, set dim and blur, or remove it. It only holds the choice; the
 * section saves it with the theme.
 */

import { createElement, appendChildren, setText } from "../../lib/dom";
import { settingsText as t } from "../../i18n/settings";
import {
  DEFAULT_BACKGROUND_DIM,
  MAX_BACKGROUND_BLUR,
  MAX_BACKGROUND_DIM,
  type ThemeBackground,
} from "./customTheme";
import {
  BACKGROUND_ACCEPT,
  MAX_BACKGROUND_FILE_BYTES,
  prepareBackground,
  type BackgroundProblem,
} from "./themeBackground";

export interface BackgroundEditor {
  readonly el: HTMLElement;
  /** The picture as chosen now, or null for none. */
  value(): ThemeBackground | null;
  /** Show `background` (null for none) and forget any pick in progress. */
  reset(background: ThemeBackground | null): void;
  /** True while a picked file is still being prepared. */
  busy(): boolean;
}

function problemText(problem: BackgroundProblem): string {
  if (problem === "type") return t("appearance.customThemes.background.type");
  if (problem === "tooBig") {
    return t("appearance.customThemes.background.tooBig", {
      limit: MAX_BACKGROUND_FILE_BYTES / (1024 * 1024),
    });
  }
  return t("appearance.customThemes.background.unreadable");
}

function slider(label: string, max: number): HTMLInputElement {
  return createElement("input", {
    class: "settings-slider",
    type: "range",
    min: "0",
    max: String(max),
    step: "1",
    "aria-label": label,
  });
}

export function buildBackgroundEditor(signal: AbortSignal): BackgroundEditor {
  const el = createElement("div", {
    class: "custom-theme-bg",
    "data-testid": "custom-theme-bg",
  });
  const title = createElement(
    "span",
    { class: "custom-theme-label" },
    t("appearance.customThemes.background"),
  );
  const desc = createElement(
    "p",
    { class: "setting-desc" },
    t("appearance.customThemes.background.desc"),
  );
  const preview = createElement("img", {
    class: "custom-theme-bg-preview",
    alt: t("appearance.customThemes.background.previewAlt"),
    hidden: "",
    "data-testid": "custom-theme-bg-preview",
  });
  const fileInput = createElement("input", {
    type: "file",
    accept: BACKGROUND_ACCEPT,
    hidden: "",
    "data-testid": "custom-theme-bg-file",
  });
  const chooseBtn = createElement("button", { class: "ac-btn secondary", type: "button" });
  const removeBtn = createElement(
    "button",
    { class: "ac-btn secondary", type: "button", "data-testid": "custom-theme-bg-remove" },
    t("appearance.customThemes.background.remove"),
  );
  const buttons = createElement("div", { class: "custom-theme-actions" });
  appendChildren(buttons, chooseBtn, removeBtn, fileInput);
  const status = createElement("p", {
    class: "custom-theme-bg-status",
    role: "status",
    "data-testid": "custom-theme-bg-status",
  });

  const dimSlider = slider(t("appearance.customThemes.background.dim"), MAX_BACKGROUND_DIM);
  const dimValue = createElement("span", { class: "slider-val" });
  const blurSlider = slider(t("appearance.customThemes.background.blur"), MAX_BACKGROUND_BLUR);
  const blurValue = createElement("span", { class: "slider-val" });
  const controls = createElement("div", { class: "custom-theme-bg-controls" });
  for (const [name, input, value] of [
    [t("appearance.customThemes.background.dim"), dimSlider, dimValue],
    [t("appearance.customThemes.background.blur"), blurSlider, blurValue],
  ] as const) {
    const row = createElement("label", { class: "custom-theme-bg-slider" });
    appendChildren(row, createElement("span", {}, name), input, value);
    controls.appendChild(row);
  }
  appendChildren(el, title, desc, preview, buttons, controls, status);

  let image: string | null = null;
  /** Bumped by every pick and reset, so a slow, superseded pick is dropped. */
  let pick = 0;
  let preparing = false;

  function paintValues(): void {
    const dim = Number(dimSlider.value);
    const blur = Number(blurSlider.value);
    const dimText = t("appearance.customThemes.background.dimValue", { percent: dim });
    const blurText = t("appearance.customThemes.background.blurValue", { px: blur });
    setText(dimValue, dimText);
    setText(blurValue, blurText);
    dimSlider.setAttribute("aria-valuetext", dimText);
    blurSlider.setAttribute("aria-valuetext", blurText);
  }

  function paintImage(): void {
    const has = image !== null;
    preview.hidden = !has;
    if (has) preview.src = image as string;
    else preview.removeAttribute("src");
    removeBtn.hidden = !has;
    controls.hidden = !has;
    setText(
      chooseBtn,
      t(
        has
          ? "appearance.customThemes.background.change"
          : "appearance.customThemes.background.choose",
      ),
    );
  }

  async function onPicked(file: File): Promise<void> {
    const mine = ++pick;
    preparing = true;
    chooseBtn.disabled = true;
    setText(status, t("appearance.customThemes.background.working"));
    const result = await prepareBackground(file);
    if (mine !== pick) return;
    preparing = false;
    chooseBtn.disabled = false;
    if (!result.ok) {
      setText(status, problemText(result.problem));
      return;
    }
    setText(status, t("appearance.customThemes.background.notExported"));
    image = result.image;
    paintImage();
  }

  chooseBtn.addEventListener("click", () => fileInput.click(), { signal });
  fileInput.addEventListener(
    "change",
    () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (file !== undefined) void onPicked(file);
    },
    { signal },
  );
  removeBtn.addEventListener(
    "click",
    () => {
      image = null;
      setText(status, "");
      paintImage();
      chooseBtn.focus();
    },
    { signal },
  );
  dimSlider.addEventListener("input", paintValues, { signal });
  blurSlider.addEventListener("input", paintValues, { signal });

  function reset(background: ThemeBackground | null): void {
    pick++;
    preparing = false;
    chooseBtn.disabled = false;
    image = background?.image ?? null;
    dimSlider.value = String(background?.dim ?? DEFAULT_BACKGROUND_DIM);
    blurSlider.value = String(background?.blur ?? 0);
    setText(status, "");
    paintValues();
    paintImage();
  }

  reset(null);
  return {
    el,
    value: () =>
      image === null
        ? null
        : { image, dim: Number(dimSlider.value), blur: Number(blurSlider.value) },
    reset,
    busy: () => preparing,
  };
}
