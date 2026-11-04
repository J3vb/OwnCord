/**
 * The call's end-to-end encryption chip, shared by the voice widget and the DM
 * call panel: a shield icon plus "Secured", or a red "Unsecured" once the
 * encryption worker failed after the key exchange.
 */
import { createElement, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { voiceText as t } from "../../i18n/voice";

export interface SecuredBadge {
  readonly el: HTMLSpanElement;
  /** Hidden until connected; never green again once encryption degraded. */
  sync(connected: boolean, encryptionDegraded: boolean): void;
}

export function createSecuredBadge(testId: string): SecuredBadge {
  const el = createElement("span", { class: "vw-secured", "data-testid": testId });
  const text = createElement("span", {});
  el.appendChild(text);
  let drawn: boolean | null = null;

  function sync(connected: boolean, encryptionDegraded: boolean): void {
    el.style.display = connected ? "inline-flex" : "none";
    const degraded = connected && encryptionDegraded;
    if (degraded === drawn) return;
    drawn = degraded;
    el.classList.toggle("vw-secured--degraded", degraded);
    el.querySelector("svg")?.remove();
    el.prepend(createIcon(degraded ? "shield-alert" : "shield-check", 12));
    setText(text, t(degraded ? "widget.unsecured" : "widget.secured"));
    el.title = t(degraded ? "encryption.unsecuredLabel" : "encryption.securedLabel");
  }

  sync(false, false);
  return { el, sync };
}
