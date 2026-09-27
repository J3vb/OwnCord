/**
 * ScreenSharePicker — the "ask before you share" dialog (design state 12).
 *
 * Replaces the minimal `features/voice/native/screenPicker.ts` modal with one
 * OwnCord-styled dialog: Screens/Applications tabs with a live thumbnail per
 * source, a stream-quality override and Go Live. Nothing is
 * captured before Go Live — the host's `startScreen` runs only after this
 * resolves (the caller owns that step).
 *
 * Wayland has no enumerable sources: the system portal owns the source choice
 * and the consent, so `portal: true` shows only the Quality step and
 * resolves `"portal"` for the host to hand to the portal.
 *
 * Linux native capture is video-only, so the Audio option says so instead of
 * offering a switch that would do nothing.
 *
 * Built on `createModal`, so it carries the shared dialog contract (role,
 * modal, focus trap, Escape, focus restore). All copy lives in the `voice`
 * catalog.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { createModal, type ModalInstance } from "@lib/modalFactory";
import type { NativeVoiceScreenSource } from "../platform/contracts/nativeVoice";
import { voiceText as t } from "../i18n/voice";
import { getEffectiveScreenShareFps, type StreamQuality } from "@lib/screenShare";

export interface ScreenSharePick {
  /** The host source id, or "portal" on Wayland. */
  source: string;
  quality: StreamQuality;
  fps: number;
}

export interface ScreenSharePickerOptions {
  /** Enumerated sources. Empty on Wayland, where the portal picks. */
  readonly sources: readonly NativeVoiceScreenSource[];
  /** True on Wayland: the portal owns the source choice and the consent. */
  readonly portal: boolean;
  readonly defaultQuality: StreamQuality;
  readonly defaultFps: number;
}

interface QualityOption {
  readonly value: StreamQuality;
  readonly label: string;
}

const FPS_OPTIONS: readonly number[] = [60, 120];

/** Linux native capture is video-only, so the Audio option is a note. */
function buildAudioOption(): HTMLElement {
  const wrap = createElement("div", { class: "ssp-opt" });
  wrap.appendChild(createElement("div", { class: "ssp-opt-label" }, t("picker.audio")));
  wrap.appendChild(createElement("div", { class: "ssp-opt-text" }, t("picker.audioUnavailable")));
  return wrap;
}

/** Resolve the source to share, or null when the user closed the dialog. */
export function showScreenSharePicker(
  opts: ScreenSharePickerOptions,
): Promise<ScreenSharePick | null> {
  return new Promise((resolve) => {
    let picked: ScreenSharePick | null = null;

    const qualityOptions: readonly QualityOption[] = [
      { value: "low", label: t("picker.quality.low") },
      { value: "medium", label: t("picker.quality.medium") },
      { value: "high", label: t("picker.quality.high") },
      { value: "source", label: t("picker.quality.source") },
    ];

    const content = createElement("div", { class: "screen-share-picker" });

    const header = createElement("div", { class: "modal-header" });
    header.appendChild(createElement("h3", { id: "screen-share-picker-title" }, t("picker.title")));
    content.appendChild(header);

    let selectedSource: string | null = null;
    let selectedQuality: StreamQuality = opts.defaultQuality;
    let selectedFps: number = opts.defaultFps;
    /** Set once the footer is built; the source list is built first, so a
     *  source pre-selection before then is a safe no-op. */
    let goLive: HTMLButtonElement | null = null;

    /** Go Live stays disabled until a source is chosen. */
    function updateGoLive(): void {
      if (goLive !== null) goLive.disabled = selectedSource === null;
    }

    // ---- Source list (X11) or portal note (Wayland) ------------------------
    const body = createElement("div", { class: "modal-body" });

    if (opts.portal) {
      body.appendChild(createElement("p", { class: "ssp-portal" }, t("picker.portalNote")));
      // The portal's dialog is the source choice, so a source id is fixed.
      selectedSource = "portal";
    } else {
      const screens = opts.sources.filter((s) => s.kind === "screen");
      const windows = opts.sources.filter((s) => s.kind !== "screen");

      if (opts.sources.length === 0) {
        body.appendChild(createElement("p", { class: "ssp-empty" }, t("picker.none")));
      } else {
        const tablist = createElement("div", {
          class: "ssp-tabs",
          role: "tablist",
          "aria-label": t("picker.tabsLabel"),
        });
        const panel = createElement("div", {
          class: "ssp-sources",
          role: "radiogroup",
          "aria-label": t("picker.sourcesLabel"),
        });

        const tabs: Array<{
          id: "screens" | "windows";
          label: string;
          items: readonly NativeVoiceScreenSource[];
        }> = [
          {
            id: "screens",
            label: t("picker.screensTab", { count: screens.length }),
            items: screens,
          },
          {
            id: "windows",
            label: t("picker.appsTab", { count: windows.length }),
            items: windows,
          },
        ];
        let activeTab: "screens" | "windows" = screens.length > 0 ? "screens" : "windows";

        const tabButtons = new Map<"screens" | "windows", HTMLButtonElement>();
        /** The source last chosen in each tab, restored when the tab is shown. */
        const tabSelection = new Map<"screens" | "windows", string>();

        function renderPanel(): void {
          while (panel.firstChild) panel.removeChild(panel.firstChild);
          const items = tabs.find((tab) => tab.id === activeTab)?.items ?? [];
          if (items.length === 0) {
            panel.appendChild(createElement("p", { class: "ssp-empty" }, t("picker.tabEmpty")));
            return;
          }
          for (const source of items) {
            panel.appendChild(sourceCard(source));
          }
        }

        function selectSource(id: string): void {
          selectedSource = id;
          tabSelection.set(activeTab, id);
          for (const card of panel.querySelectorAll<HTMLButtonElement>(".ssp-source")) {
            const on = card.dataset["sourceId"] === id;
            card.setAttribute("aria-checked", String(on));
            card.tabIndex = on ? 0 : -1;
          }
          updateGoLive();
        }

        function sourceCard(source: NativeVoiceScreenSource): HTMLButtonElement {
          const card = createElement("button", {
            class: "ssp-source",
            type: "button",
            role: "radio",
            "aria-checked": "false",
            tabindex: "-1",
            "data-source-id": source.id,
          });
          const kind = source.kind === "screen" ? t("picker.screen") : t("picker.window");
          card.setAttribute(
            "aria-label",
            t("picker.shareLabel", { name: `${kind}: ${source.title}` }),
          );

          const thumb = createElement("span", { class: "ssp-thumb" });
          if (source.thumbnail !== null) {
            thumb.appendChild(createElement("img", { src: source.thumbnail, alt: "" }));
          } else {
            thumb.appendChild(
              createElement("span", { class: "ssp-nothumb" }, t("picker.noPreview")),
            );
          }

          const title = createElement("span", { class: "ssp-title" }, source.title);
          const sub = createElement("span", { class: "ssp-sub" }, kind);
          appendChildren(card, thumb, title, sub);

          card.addEventListener("click", () => selectSource(source.id));
          return card;
        }

        function setActiveTab(id: "screens" | "windows", focus: boolean): void {
          activeTab = id;
          for (const [tabId, btn] of tabButtons) {
            const on = tabId === id;
            btn.setAttribute("aria-selected", String(on));
            btn.tabIndex = on ? 0 : -1;
          }
          renderPanel();
          // Restore this tab's last choice (else its first card), so Go Live
          // shares what the user sees and the radiogroup keeps a roving tab stop.
          const cards = [...panel.querySelectorAll<HTMLButtonElement>(".ssp-source")];
          const remembered = tabSelection.get(id);
          const shown = cards.find((c) => c.dataset["sourceId"] === remembered) ?? cards[0];
          if (shown?.dataset["sourceId"] !== undefined) {
            selectSource(shown.dataset["sourceId"]);
          } else {
            selectedSource = null;
            updateGoLive();
          }
          if (focus) tabButtons.get(id)?.focus();
        }

        for (const tab of tabs) {
          const btn = createElement("button", {
            class: "ssp-tab",
            type: "button",
            role: "tab",
            "aria-selected": "false",
            tabindex: "-1",
            id: `screen-share-tab-${tab.id}`,
          });
          btn.appendChild(document.createTextNode(tab.label));
          btn.addEventListener("click", () => setActiveTab(tab.id, false));
          tabButtons.set(tab.id, btn);
          tablist.appendChild(btn);
        }

        tablist.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          const next: "screens" | "windows" = activeTab === "screens" ? "windows" : "screens";
          setActiveTab(next, true);
        });

        panel.addEventListener("keydown", (e: KeyboardEvent) => {
          // i18n-exempt: KeyboardEvent.key values, wire identifiers, never displayed
          const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
          if (!keys.includes(e.key)) return;
          const cards = [...panel.querySelectorAll<HTMLButtonElement>(".ssp-source")];
          if (cards.length === 0) return;
          e.preventDefault();
          const current = cards.findIndex((c) => c.getAttribute("aria-checked") === "true");
          let next: number;
          if (e.key === "Home") next = 0;
          else if (e.key === "End") next = cards.length - 1;
          else if (e.key === "ArrowRight" || e.key === "ArrowDown")
            next = (current + 1) % cards.length;
          else next = (current - 1 + cards.length) % cards.length;
          cards[next]!.click();
          cards[next]!.focus();
        });

        body.appendChild(tablist);
        body.appendChild(panel);

        setActiveTab(activeTab, false);
      }
    }

    // ---- Options: audio note + quality -------------------------------------
    const options = createElement("div", { class: "ssp-options" });
    options.appendChild(buildAudioOption());
    options.appendChild(buildQualityOption());
    body.appendChild(options);
    content.appendChild(body);

    function buildQualityOption(): HTMLElement {
      const wrap = createElement("div", { class: "ssp-opt" });
      wrap.appendChild(createElement("div", { class: "ssp-opt-label" }, t("picker.quality")));
      const row = createElement("div", { class: "ssp-opt-row" });

      const qualitySelect = createElement("select", {
        class: "ssp-select",
        "aria-label": t("picker.quality"),
      });
      for (const opt of qualityOptions) {
        qualitySelect.appendChild(createElement("option", { value: opt.value }, opt.label));
      }
      qualitySelect.value = selectedQuality;
      qualitySelect.addEventListener("change", () => {
        selectedQuality = qualitySelect.value as StreamQuality;
        setText(defaultFpsOption, defaultFpsLabel());
      });

      const fpsSelect = createElement("select", {
        class: "ssp-select",
        "aria-label": t("picker.frameRate"),
      });
      // 30 is the saved-prefs "default": each quality's own rate (5/15/30).
      const defaultFpsLabel = (): string =>
        t("picker.fpsDefault", { fps: getEffectiveScreenShareFps(selectedQuality, 30) });
      const defaultFpsOption = createElement("option", { value: "30" }, defaultFpsLabel());
      fpsSelect.appendChild(defaultFpsOption);
      for (const fps of FPS_OPTIONS) {
        fpsSelect.appendChild(
          createElement("option", { value: String(fps) }, t("picker.fps", { fps })),
        );
      }
      if (!FPS_OPTIONS.includes(selectedFps)) selectedFps = 30;
      fpsSelect.value = String(selectedFps);
      fpsSelect.addEventListener("change", () => {
        selectedFps = Number(fpsSelect.value);
      });

      appendChildren(row, qualitySelect, fpsSelect);
      wrap.appendChild(row);
      wrap.appendChild(createElement("div", { class: "ssp-hint" }, t("picker.qualityHint")));
      return wrap;
    }

    // ---- Footer -------------------------------------------------------------
    const footer = createElement("div", { class: "modal-footer" });
    const cancel = createElement(
      "button",
      { class: "btn-modal-cancel", type: "button" },
      t("picker.cancel"),
    );
    goLive = createElement("button", {
      class: "btn-modal-save ssp-go",
      type: "button",
      "data-testid": "screen-share-go-live",
    });
    goLive.appendChild(createIcon("monitor", 16));
    goLive.appendChild(document.createTextNode(t("picker.goLive")));
    appendChildren(footer, cancel, goLive);
    content.appendChild(footer);
    updateGoLive();

    let modal: ModalInstance | null = null;
    const close = (): void => {
      modal?.close();
    };
    goLive.addEventListener("click", () => {
      if (selectedSource === null) return;
      picked = {
        source: selectedSource,
        quality: selectedQuality,
        fps: selectedFps,
      };
      close();
    });
    cancel.addEventListener("click", close);

    modal = createModal({
      content,
      ariaLabelledBy: "screen-share-picker-title",
      overlayAttrs: { "data-testid": "screen-share-picker" },
      onClose: () => resolve(picked),
    });
    // The shared .modal is a fixed 440px; widen it so the source grid's
    // columns fit instead of scrolling sideways (same approach as the picker
    // this replaced).
    modal.modal.style.width = "min(720px, 92vw)";

    // Wayland has no source grid: focus the first interactive control.
    const firstInteractive = content.querySelector<HTMLElement>("button, select");
    firstInteractive?.focus();
  });
}
