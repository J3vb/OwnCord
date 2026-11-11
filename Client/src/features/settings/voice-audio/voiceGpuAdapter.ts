/**
 * The "Graphics card for video" row (Windows). The host applies the choice at
 * its next start, so a change shows a restart button. The row stays out of
 * the page when the host cannot list cards or the PC has none.
 */
import { createElement } from "@lib/dom";
import { desktop } from "../../../platform/desktop";
import type { GpuAdapterState } from "../../../platform/contracts/gpuAdapter";
import { settingsText as t } from "../../../i18n/settings";

const AUTO = "auto";

function note(text: string): HTMLElement {
  return createElement("p", { class: "setting-desc" }, text);
}

function build(state: GpuAdapterState, signal: AbortSignal): HTMLElement[] {
  const label = t("voiceAudio.gpuAdapter");
  const select = createElement("select", {
    class: "form-input",
    style: "width:100%;margin-bottom:8px",
    "aria-label": label,
    "data-testid": "gpu-adapter-select",
  });
  select.appendChild(createElement("option", { value: AUTO }, t("voiceAudio.gpuAdapter.auto")));
  for (const card of state.cards) {
    select.appendChild(createElement("option", { value: card.id }, card.name));
  }
  const known = state.cards.some((c) => c.id === state.saved);
  select.value = known ? state.saved : AUTO;

  const status = createElement("p", { class: "setting-desc", role: "status" });
  const restart = createElement(
    "button",
    { class: "ac-btn", type: "button", "data-testid": "gpu-adapter-restart" },
    t("voiceAudio.gpuAdapterRestart"),
  );
  restart.hidden = true;

  let saved = select.value;
  const save = (choice: string): void => {
    void (async () => {
      const ok = await desktop.gpuAdapter.set(choice);
      if (signal.aborted) return;
      if (!ok) {
        select.value = saved;
        status.textContent = t("voiceAudio.gpuAdapterNotSaved");
        return;
      }
      saved = choice;
      status.textContent = "";
      restart.hidden = false;
    })();
  };
  select.addEventListener("change", () => save(select.value), { signal });
  restart.addEventListener(
    "click",
    () => {
      restart.disabled = true;
      void desktop.appProcess.relaunch().catch(() => {
        restart.disabled = false;
      });
    },
    { signal },
  );

  const out = [
    createElement("div", { class: "settings-field-label" }, label),
    note(t("voiceAudio.gpuAdapterDesc")),
    select,
  ];
  if (state.notFound) out.push(note(t("voiceAudio.gpuAdapterNotFound")));
  if (state.resetAfterCrash) out.push(note(t("voiceAudio.gpuAdapterReset")));
  out.push(status, restart);
  return out;
}

/** An empty holder that fills once the host answers. */
export function mountGpuAdapterRow(parent: HTMLElement, signal: AbortSignal): void {
  if (!desktop.gpuAdapter.available) return;
  const holder = createElement("div", { "data-testid": "gpu-adapter-row" });
  parent.appendChild(holder);
  void desktop.gpuAdapter.list().then((state) => {
    if (signal.aborted) return;
    if (state === null || state.cards.length === 0) {
      holder.remove();
      return;
    }
    holder.append(...build(state, signal));
  });
}
