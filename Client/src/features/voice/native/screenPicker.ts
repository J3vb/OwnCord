// The Linux screen-share source picker. The web path gets the browser's own
// getDisplayMedia picker; the native path picks here, from the host's
// enumeration (`NativeVoice.screenSources`): screens and windows, each shown
// with a thumbnail of what would be shared, so the user sees it before
// sharing starts. On Wayland the host cannot enumerate anything — the
// desktop portal's dialog is the picker (and the consent), so this returns
// "portal" without showing anything.
import { createElement } from "../../../lib/dom";
import { createModal } from "../../../lib/modalFactory";
import { desktop } from "../../../platform/desktop";
import type { NativeVoiceScreenSource } from "../../../platform/contracts/nativeVoice";
import { voiceText as t } from "../../../i18n/voice";

/** Resolve the source to share: a host source id, "portal", or null when
 *  the user closed the picker. */
export async function pickScreenSource(): Promise<string | null> {
  const listed = await desktop.nativeVoice.screenSources();
  if (listed.portal) return "portal";
  return new Promise((resolve) => {
    let picked: string | null = null;
    const content = createElement("div", {
      class: "native-screen-picker",
      style: "padding:20px;",
    });
    content.appendChild(
      createElement("h3", { id: "native-screen-picker-title" }, t("picker.title")),
    );
    const cards = createElement("div", {
      style:
        "display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;max-height:60vh;overflow-y:auto;margin:12px 0;",
    });
    content.appendChild(cards);
    const modal = createModal({
      content,
      ariaLabelledBy: "native-screen-picker-title",
      overlayAttrs: { "data-testid": "native-screen-picker" },
      onClose: () => resolve(picked),
    });
    // The shared .modal is a fixed 440px; widen this one so the grid's
    // columns fit instead of scrolling sideways out of view.
    modal.modal.style.width = "min(720px, 90vw)";
    for (const source of listed.sources) {
      const card = sourceCard(source);
      card.addEventListener("click", () => {
        picked = source.id;
        modal.close();
      });
      cards.appendChild(card);
    }
    if (listed.sources.length === 0)
      cards.appendChild(
        createElement("p", { style: "color:var(--text-secondary);" }, t("picker.none")),
      );
    const cancel = createElement("button", { class: "btn", type: "button" }, t("picker.cancel"));
    cancel.addEventListener("click", () => modal.close());
    content.appendChild(cancel);
  });
}

function sourceCard(source: NativeVoiceScreenSource): HTMLButtonElement {
  const card = createElement("button", {
    class: "btn native-screen-source",
    type: "button",
    "data-source-id": source.id,
    style:
      "display:flex;flex-direction:column;gap:6px;align-items:stretch;padding:8px;min-width:0;text-align:left;",
  });
  const kind = source.kind === "screen" ? t("picker.screen") : t("picker.window");
  const label = `${kind}: ${source.title}`;
  card.setAttribute("aria-label", t("picker.shareLabel", { name: label }));
  const frame = createElement("div", {
    style:
      "aspect-ratio:16/9;background:var(--bg-tertiary,#000);display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:4px;",
  });
  if (source.thumbnail !== null)
    frame.appendChild(
      createElement("img", {
        src: source.thumbnail,
        alt: "",
        style: "max-width:100%;max-height:100%;",
      }),
    );
  else frame.appendChild(createElement("span", {}, t("picker.noPreview")));
  card.appendChild(frame);
  card.appendChild(
    createElement(
      "span",
      { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" },
      label,
    ),
  );
  return card;
}
