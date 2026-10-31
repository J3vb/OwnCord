import { afterEach, beforeEach } from "vitest";

/**
 * Registers the beforeEach/afterEach that give each test a fresh <div> on
 * document.body and remove it afterwards. `bind` receives each new element so
 * the suite can keep it in a local.
 */
export function useMountContainer(bind: (container: HTMLDivElement) => void): void {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    bind(container);
  });

  afterEach(() => {
    container.remove();
  });
}
