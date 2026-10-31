import { afterEach, beforeEach } from "vitest";
import { buildNotificationsTab } from "../../src/features/settings/NotificationsTab";

/**
 * Gives each test a container on the body and a fresh AbortController, aborts
 * and removes them afterwards, and returns `build` to mount a Notifications tab.
 */
export function useNotificationsTabHost() {
  let container: HTMLDivElement;
  let ac: AbortController;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    ac = new AbortController();
  });

  afterEach(() => {
    ac.abort();
    container.remove();
  });

  return {
    container: (): HTMLDivElement => container,
    build(): HTMLDivElement {
      const tab = buildNotificationsTab(ac.signal);
      container.appendChild(tab);
      return tab;
    },
  };
}
