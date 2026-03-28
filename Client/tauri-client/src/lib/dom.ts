// Step 1.11 — Safe DOM utilities
// NEVER use innerHTML with user-provided content.
// All user content must go through these helpers.

/**
 * Escape HTML special characters to prevent XSS.
 * Use this when building HTML strings that include user data.
 */
export function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Create an element with optional attributes and text content.
 * Text is set via textContent (safe from XSS).
 */
export function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  textContent?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") {
        el.className = value;
      } else {
        el.setAttribute(key, value);
      }
    }
  }
  if (textContent !== undefined) {
    el.textContent = textContent;
  }
  return el;
}

/**
 * Set text content safely on an element.
 * Always prefer this over innerHTML for user content.
 */
export function setText(el: Element, text: string): void {
  el.textContent = text;
}

/**
 * Append multiple children to a parent element.
 */
export function appendChildren(
  parent: Element,
  ...children: (Element | string)[]
): void {
  for (const child of children) {
    if (typeof child === "string") {
      parent.appendChild(document.createTextNode(child));
    } else {
      parent.appendChild(child);
    }
  }
}

/**
 * Remove all children from an element safely.
 */
export function clearChildren(el: Element): void {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

/**
 * Query a single element with type safety.
 * Returns null if not found.
 */
export function qs<K extends keyof HTMLElementTagNameMap>(
  selector: K,
  parent?: Element,
): HTMLElementTagNameMap[K] | null;
export function qs(selector: string, parent?: Element): Element | null;
export function qs(selector: string, parent?: Element): Element | null {
  return (parent ?? document).querySelector(selector);
}

/**
 * Query all matching elements as an array.
 */
export function qsa(selector: string, parent?: Element): Element[] {
  return Array.from((parent ?? document).querySelectorAll(selector));
}
