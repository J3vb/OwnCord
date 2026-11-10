/**
 * The connect page's branding block: the OC logo monogram, the product name and
 * the tagline, shown above the server list.
 */
import { createElement, appendChildren } from "@lib/dom";
import { connectText } from "../../i18n/connect";

export function createConnectBranding(): HTMLDivElement {
  // OC Logo branding — prepended to server panel
  const branding = createElement("div", { class: "server-branding" });

  const logoSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  logoSvg.setAttribute("width", "80");
  logoSvg.setAttribute("height", "48");
  logoSvg.setAttribute("viewBox", "0 0 120 70");
  logoSvg.setAttribute("class", "oc-logo");

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const grad = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
  grad.setAttribute("id", "oc-grad");
  grad.setAttribute("x1", "0%");
  grad.setAttribute("y1", "0%");
  grad.setAttribute("x2", "100%");
  grad.setAttribute("y2", "0%");
  const stops = [
    { offset: "0%", color: "#f97316" },
    { offset: "30%", color: "#ec4899" },
    { offset: "65%", color: "#8b5cf6" },
    { offset: "100%", color: "#06b6d4" },
  ];
  for (const s of stops) {
    const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
    stop.setAttribute("offset", s.offset);
    stop.setAttribute("style", `stop-color:${s.color}`);
    grad.appendChild(stop);
  }
  const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
  filter.setAttribute("id", "oc-glow");
  const blur = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
  blur.setAttribute("stdDeviation", "4");
  blur.setAttribute("result", "blur");
  filter.appendChild(blur);
  const composite = document.createElementNS("http://www.w3.org/2000/svg", "feComposite");
  composite.setAttribute("in", "SourceGraphic");
  composite.setAttribute("in2", "blur");
  composite.setAttribute("operator", "over");
  filter.appendChild(composite);
  defs.appendChild(grad);
  defs.appendChild(filter);
  logoSvg.appendChild(defs);

  const glowText = document.createElementNS("http://www.w3.org/2000/svg", "text");
  glowText.setAttribute("x", "60");
  glowText.setAttribute("y", "56");
  glowText.setAttribute("text-anchor", "middle");
  glowText.setAttribute("font-family", "'Segoe UI',system-ui,sans-serif");
  glowText.setAttribute("font-size", "68");
  glowText.setAttribute("font-weight", "900");
  glowText.setAttribute("fill", "url(#oc-grad)");
  glowText.setAttribute("letter-spacing", "-4");
  glowText.setAttribute("opacity", "0.4");
  glowText.setAttribute("filter", "url(#oc-glow)");
  glowText.setAttribute("class", "oc-glow-layer");
  glowText.textContent = "OC"; // i18n-exempt: logo monogram, not copy
  logoSvg.appendChild(glowText);

  const sharpText = document.createElementNS("http://www.w3.org/2000/svg", "text");
  sharpText.setAttribute("x", "60");
  sharpText.setAttribute("y", "56");
  sharpText.setAttribute("text-anchor", "middle");
  sharpText.setAttribute("font-family", "'Segoe UI',system-ui,sans-serif");
  sharpText.setAttribute("font-size", "68");
  sharpText.setAttribute("font-weight", "900");
  sharpText.setAttribute("fill", "url(#oc-grad)");
  sharpText.setAttribute("letter-spacing", "-4");
  sharpText.textContent = "OC"; // i18n-exempt: logo monogram, not copy
  logoSvg.appendChild(sharpText);

  branding.appendChild(logoSvg);

  // i18n-exempt: product name, never translated
  const brandName = createElement("div", { class: "brand-name" }, "OwnCord");
  const brandTag = createElement("div", { class: "brand-tagline" }, connectText("brand.tagline"));
  appendChildren(branding, brandName, brandTag);
  return branding;
}
