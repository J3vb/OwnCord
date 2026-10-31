/**
 * Runs `body` with every HTMLElement reporting the given offsetWidth and
 * offsetHeight (jsdom has no layout), then removes the stub even if it throws.
 */
export function withMeasuredSize<T>(width: number, height: number, body: () => T): T {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    value: height,
  });
  try {
    return body();
  } finally {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)["offsetWidth"];
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)["offsetHeight"];
  }
}
