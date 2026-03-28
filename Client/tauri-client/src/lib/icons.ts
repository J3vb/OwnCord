/**
 * Centralized Lucide SVG icon factory.
 *
 * All path data is taken verbatim from the Lucide icon set (lucide.dev).
 * Icons are rendered as inline SVG elements with `currentColor` stroke so
 * they inherit the text color of their parent element.
 *
 * Usage:
 *   import { createIcon } from "./icons";
 *   const svg = createIcon("mic", 20);
 *   parent.appendChild(svg);
 */

// ---------------------------------------------------------------------------
// Icon name union
// ---------------------------------------------------------------------------

export type IconName =
  | "mic"
  | "mic-off"
  | "headphones"
  | "headphones-off"
  | "camera"
  | "camera-off"
  | "monitor"
  | "monitor-off"
  | "phone"
  | "phone-off"
  | "volume-2"
  | "volume-x"
  | "pin"
  | "pin-off"
  | "users"
  | "settings"
  | "smile"
  | "send"
  | "reply"
  | "pencil"
  | "trash-2"
  | "file-text"
  | "download"
  | "chevron-down"
  | "chevron-right"
  | "x"
  | "eye"
  | "eye-off"
  | "play"
  | "pause"
  | "check"
  | "external-link"
  | "loader"
  | "arrow-right"
  | "hash"
  | "triangle-alert"
  | "user"
  | "palette"
  | "bell"
  | "keyboard"
  | "scroll-text"
  | "image"
  | "signal"
  | "log-out"
  | "zap";

// ---------------------------------------------------------------------------
// SVG inner content (innerHTML) — Lucide 0.x path data
// Each string contains the full set of child elements that live inside <svg>.
// ---------------------------------------------------------------------------

const ICON_PATHS: Record<IconName, string> = {
  // Microphone
  mic: `<path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>`,

  // Microphone with slash
  "mic-off": `<line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/>`,

  // Headphones
  headphones: `<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>`,

  // Headphones with a diagonal slash (Lucide does not have headphones-off; we add a slash line)
  "headphones-off": `<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/><line x1="2" x2="22" y1="2" y2="22"/>`,

  // Camera / video camera
  camera: `<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>`,

  // Camera with slash
  "camera-off": `<line x1="2" x2="22" y1="2" y2="22"/><path d="M7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16"/><path d="M9.5 4h5L17 7h3a2 2 0 0 1 2 2v7.5"/><path d="M14.121 15.121A3 3 0 1 1 9.88 10.88"/>`,

  // Desktop monitor
  monitor: `<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>`,

  // Monitor with slash
  "monitor-off": `<path d="M17 17H4a2 2 0 0 1-2-2V5c0-1.5 1-2 1-2"/><path d="M22 15V5a2 2 0 0 0-2-2H9"/><path d="M8 21h8"/><path d="M12 17v4"/><line x1="2" x2="22" y1="2" y2="22"/>`,

  // Phone handset (disconnect — styled red via CSS)
  phone: `<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>`,

  // Phone with slash (kept for potential future use)
  "phone-off": `<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07"/><path d="M14.5 6.5a4 4 0 0 0-5.79 5.49"/><line x1="2" x2="22" y1="2" y2="22"/>`,

  // Speaker with sound waves
  "volume-2": `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>`,

  // Speaker muted (X)
  "volume-x": `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" x2="17" y1="9" y2="15"/><line x1="17" x2="23" y1="9" y2="15"/>`,

  // Map pin / thumbtack
  pin: `<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>`,

  // Pin with slash
  "pin-off": `<line x1="2" x2="22" y1="2" y2="22"/><path d="M12 17.001V22"/><path d="M9 9a3 3 0 0 0 5.12 2.12"/><path d="M20 10a8 8 0 0 0-8-8 8 8 0 0 0-5.46 2.13"/>`,

  // Multiple people
  users: `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,

  // Gear / settings cog
  settings: `<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,

  // Smiley face
  smile: `<circle cx="12" cy="12" r="10"/><path d="M8 13s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/>`,

  // Paper plane / send
  send: `<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>`,

  // Reply / corner-up-left
  reply: `<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>`,

  // Edit pencil
  pencil: `<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>`,

  // Trash can
  "trash-2": `<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>`,

  // Document with text lines
  "file-text": `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>`,

  // Download arrow
  download: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>`,

  // Down chevron
  "chevron-down": `<path d="m6 9 6 6 6-6"/>`,

  // Right chevron
  "chevron-right": `<path d="m9 18 6-6-6-6"/>`,

  // X / close
  x: `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,

  // Eye open
  eye: `<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>`,

  // Eye with slash
  "eye-off": `<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>`,

  // Play triangle
  play: `<polygon points="5 3 19 12 5 21 5 3"/>`,

  // Pause bars
  pause: `<rect width="4" height="16" x="6" y="4"/><rect width="4" height="16" x="14" y="4"/>`,

  // Checkmark
  check: `<path d="M20 6 9 17l-5-5"/>`,

  // External link arrow out of box
  "external-link": `<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`,

  // Loading spinner circle (partial arc with rotating convention)
  loader: `<path d="M21 12a9 9 0 1 1-6.219-8.56"/>`,

  // Right arrow
  "arrow-right": `<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>`,

  // Hash / pound symbol
  hash: `<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>`,

  // Alert triangle / warning
  "triangle-alert": `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`,

  // Single person / user
  user: `<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`,

  // Artist palette
  palette: `<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>`,

  // Notification bell
  bell: `<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>`,

  // Keyboard
  keyboard: `<rect width="20" height="16" x="2" y="4" rx="2" ry="2"/><path d="M6 8h.001"/><path d="M10 8h.001"/><path d="M14 8h.001"/><path d="M18 8h.001"/><path d="M8 12h.001"/><path d="M12 12h.001"/><path d="M16 12h.001"/><path d="M7 16h10"/>`,

  // Scroll with text
  "scroll-text": `<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2"/>`,

  // Image / photo
  image: `<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>`,

  // Signal strength (4 bars)
  signal: `<rect x="2" y="12" width="3" height="4" rx="0.5" fill="currentColor"/><rect x="7" y="8" width="3" height="8" rx="0.5" fill="currentColor"/><rect x="12" y="4" width="3" height="12" rx="0.5" fill="currentColor"/><rect x="17" y="0" width="3" height="16" rx="0.5" fill="currentColor"/>`,

  // Log out / exit door with arrow
  "log-out": `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>`,

  // Lightning bolt (auto-login indicator)
  zap: `<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>`,
};

// ---------------------------------------------------------------------------
// Icon factory
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Create a Lucide SVG icon element.
 *
 * @param name - One of the defined icon names.
 * @param size - Width and height in pixels (default: 24).
 * @returns An SVGSVGElement ready to be appended to the DOM.
 */
export function createIcon(name: IconName, size = 24): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");

  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("data-icon", name);
  svg.classList.add("icon");

  // Safe: path data comes entirely from the static ICON_PATHS constant above,
  // never from user-provided input.
  svg.innerHTML = ICON_PATHS[name];

  return svg;
}

/** Create a signal-strength icon with per-bar coloring based on quality level.
 *  Bars are colored by the quality thresholds; unfilled bars use --bg-active. */
export function createSignalIcon(
  barsLit: number,
  color: string,
  size = 16,
): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 22 16");
  svg.setAttribute("fill", "none");

  const bars = [
    { x: 2, y: 12, w: 3, h: 4 },
    { x: 7, y: 8, w: 3, h: 8 },
    { x: 12, y: 4, w: 3, h: 12 },
    { x: 17, y: 0, w: 3, h: 16 },
  ];

  const dimColor = "var(--bg-active, #383a40)";

  for (let i = 0; i < bars.length; i++) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    const b = bars[i]!;
    rect.setAttribute("x", String(b.x));
    rect.setAttribute("y", String(b.y));
    rect.setAttribute("width", String(b.w));
    rect.setAttribute("height", String(b.h));
    rect.setAttribute("rx", "0.5");
    rect.setAttribute("fill", i < barsLit ? color : dimColor);
    svg.appendChild(rect);
  }

  return svg;
}
