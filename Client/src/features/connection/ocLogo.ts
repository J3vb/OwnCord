/**
 * The OC logo monogram shared by the connect page's brand block and the
 * sign-in form. The blurred glow is its own small SVG under the sharp logo
 * and only its opacity pulses, so the browser can run the pulse on the
 * compositor instead of restyling the page on every frame.
 */
const SVG_NS = "http://www.w3.org/2000/svg";

// i18n-exempt: CSS font stack, not copy
const MONOGRAM_FONT = "'Segoe UI',system-ui,sans-serif";

const GRADIENT_STOPS = [
  ["0%", "#f97316"],
  ["30%", "#ec4899"],
  ["65%", "#8b5cf6"],
  ["100%", "#06b6d4"],
] as const;

export interface OcLogoOptions {
  /** Distinguishes the gradient and filter ids of two logos on one page. */
  readonly idSuffix: string;
  readonly width: number;
  readonly height: number;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}

function buildGradient(id: string): SVGLinearGradientElement {
  const grad = svgEl("linearGradient", { id, x1: "0%", y1: "0%", x2: "100%", y2: "0%" });
  for (const [offset, color] of GRADIENT_STOPS) {
    grad.appendChild(svgEl("stop", { offset, style: `stop-color:${color}` }));
  }
  return grad;
}

function buildMonogram(gradId: string, extra: Record<string, string>): SVGTextElement {
  const text = svgEl("text", {
    x: "60",
    y: "56",
    "text-anchor": "middle",
    "font-family": MONOGRAM_FONT,
    "font-size": "68",
    "font-weight": "900",
    fill: `url(#${gradId})`,
    "letter-spacing": "-4",
    ...extra,
  });
  text.textContent = "OC"; // i18n-exempt: logo monogram, not copy
  return text;
}

function buildSvg(opts: OcLogoOptions, className: string): SVGSVGElement {
  return svgEl("svg", {
    width: String(opts.width),
    height: String(opts.height),
    viewBox: "0 0 120 70",
    class: className,
  });
}

function buildGlowSvg(opts: OcLogoOptions): SVGSVGElement {
  const gradId = `oc-grad-glow${opts.idSuffix}`;
  const filterId = `oc-glow${opts.idSuffix}`;
  const svg = buildSvg(opts, "oc-glow-svg");
  svg.setAttribute("aria-hidden", "true");
  const filter = svgEl("filter", { id: filterId });
  filter.appendChild(svgEl("feGaussianBlur", { stdDeviation: "5", result: "blur" }));
  filter.appendChild(svgEl("feComposite", { in: "SourceGraphic", in2: "blur", operator: "over" }));
  const defs = svgEl("defs", {});
  defs.appendChild(buildGradient(gradId));
  defs.appendChild(filter);
  svg.appendChild(defs);
  svg.appendChild(buildMonogram(gradId, { filter: `url(#${filterId})` }));
  return svg;
}

export function createOcLogo(opts: OcLogoOptions): HTMLSpanElement {
  const stack = document.createElement("span");
  stack.className = "oc-logo-stack";
  const gradId = `oc-grad${opts.idSuffix}`;
  const sharp = buildSvg(opts, "oc-logo");
  const defs = svgEl("defs", {});
  defs.appendChild(buildGradient(gradId));
  sharp.appendChild(defs);
  sharp.appendChild(buildMonogram(gradId, {}));
  stack.append(buildGlowSvg(opts), sharp);
  return stack;
}
