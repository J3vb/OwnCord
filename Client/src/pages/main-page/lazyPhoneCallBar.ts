/**
 * The phone call bar's loader. The bar's code stays out of the main-page
 * chunk until a phone is in a call, which is the only time it has anything to
 * show. It mounts into a placeholder kept right under the header, and takes
 * over its own visibility from then on.
 */

import { Disposable } from "@lib/disposable";
import { createElement } from "@lib/dom";
import type { MountableComponent } from "@lib/text/safeRender";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import { voiceStore } from "@stores/voice.store";
import { createLazyScreen } from "@components/lazyScreen";
import type { PhoneCallBar, PhoneCallBarOptions } from "@components/PhoneCallBar";

const phoneCallBarScreen = createLazyScreen(
  "phone-call-bar",
  () => import("@components/PhoneCallBar"),
);

export interface LazyPhoneCallBar extends MountableComponent {
  /** Re-decide whether the bar shows; nothing until it has loaded. */
  refresh(): void;
}

export function createLazyPhoneCallBar(options: PhoneCallBarOptions): LazyPhoneCallBar {
  const owner = new Disposable();
  const slot = createElement("div", {
    style: "display:contents",
    "data-testid": "phone-call-bar-slot",
  });
  let real: PhoneCallBar | null = null;
  let loading = false;

  function loadIfNeeded(): void {
    if (real !== null || loading || owner.signal.aborted) return;
    if (!isPhoneLayout() || voiceStore.getState().currentChannelId === null) return;
    loading = true;
    void phoneCallBarScreen
      .load(() => !owner.signal.aborted)
      .then((mod) => {
        loading = false;
        if (mod === null || owner.signal.aborted) return;
        real = mod.createPhoneCallBar(options);
        real.mount(slot);
      });
  }

  return {
    mount(container: Element): void {
      container.appendChild(slot);
      owner.onStoreChange(
        voiceStore,
        (s) => s.currentChannelId,
        () => loadIfNeeded(),
      );
      // Rotation and resizing move the window onto the phone layout.
      owner.onEvent(window, "resize", loadIfNeeded);
      loadIfNeeded();
    },
    refresh: () => real?.refresh(),
    destroy(): void {
      owner.destroy();
      real?.destroy?.();
      real = null;
      slot.remove();
    },
  };
}
