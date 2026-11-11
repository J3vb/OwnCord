/**
 * The connect page's branding block: the OC logo monogram, the product name and
 * the tagline, shown above the server list.
 */
import { createElement, appendChildren } from "@lib/dom";
import { connectText } from "../../i18n/connect";
import { createOcLogo } from "./ocLogo";

export function createConnectBranding(): HTMLDivElement {
  // OC Logo branding — prepended to server panel
  const branding = createElement("div", { class: "server-branding" });

  branding.appendChild(createOcLogo({ idSuffix: "", width: 80, height: 48 }));

  // i18n-exempt: product name, never translated
  const brandName = createElement("div", { class: "brand-name" }, "OwnCord");
  const brandTag = createElement("div", { class: "brand-tagline" }, connectText("brand.tagline"));
  appendChildren(branding, brandName, brandTag);
  return branding;
}
