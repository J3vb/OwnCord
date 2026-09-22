// Step 1.11 — Safe DOM utilities
// NEVER use innerHTML with user-provided content.
// All user content must go through these helpers.

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
export function appendChildren(parent: Element, ...children: (Element | string)[]): void {
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
 * A deferred UI step (a label reset, a deferred listener) owned by `signal`:
 * aborting clears it, so a torn-down owner never runs it against detached
 * nodes. The abort registration is dropped when the timer fires, so re-arming
 * never accumulates cleanups. Nothing is scheduled once `signal` has aborted.
 */
export function setOwnedTimeout(signal: AbortSignal, fn: () => void, ms: number): void {
  if (signal.aborted) return;
  const clear = (): void => clearTimeout(timer);
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", clear);
    fn();
  }, ms);
  signal.addEventListener("abort", clear, { once: true });
}
