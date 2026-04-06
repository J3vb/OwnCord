/**
 * Phase C Step 9 — Solid component that hosts a plugin tab.
 *
 * Mounts the plugin's iframe via `pluginBridge.mount(...)` and tears it down
 * when the component is disposed. The container itself is intentionally tiny:
 * the bridge owns the iframe lifecycle and the postMessage protocol.
 */

import { onMount, onCleanup, type JSX } from "solid-js";
import { pluginBridge, type PluginTabBinding } from "@lib/pluginBridge";

export interface PluginContainerProps {
  binding: PluginTabBinding;
}

export function PluginContainer(props: PluginContainerProps): JSX.Element {
  let host!: HTMLDivElement;
  let dispose: (() => void) | undefined;

  onMount(() => {
    dispose = pluginBridge.mount(props.binding, host);
  });
  onCleanup(() => {
    dispose?.();
  });

  return (
    <div class="plugin-container" data-plugin-id={props.binding.pluginId} ref={host} />
  );
}
