/**
 * Phase C Step 9 — client-side plugin bridge.
 *
 * Mounts plugin UI tabs in sandboxed iframes and forwards postMessage traffic
 * between the host client and each plugin. The host injects theme CSS
 * variables on every load so plugin UIs match OwnCord's look and feel
 * without each plugin re-implementing them.
 *
 * The bridge is intentionally tiny: it owns iframe lifecycles and message
 * routing; everything else (rendering tabs, fetching the plugin list) lives
 * in PluginContainer.tsx.
 */

export interface PluginTabBinding {
  pluginId: number;
  pluginName: string;
  tabId: string;
  label: string;
  asset: string;
}

export interface PluginMessageEnvelope {
  pluginId: number;
  type: string;
  payload?: unknown;
}

type Listener = (env: PluginMessageEnvelope) => void;

const HOST_ORIGIN_PREFIX = "owncord-plugin-host";

class PluginBridge {
  private frames = new Map<number, HTMLIFrameElement>();
  private listeners = new Set<Listener>();
  private themeVars: Record<string, string> = {};

  constructor() {
    window.addEventListener("message", this.onMessage);
  }

  /** Replace the theme variables broadcast to plugin iframes. */
  setTheme(vars: Record<string, string>): void {
    this.themeVars = { ...vars };
    for (const [pid, frame] of this.frames) {
      this.postToFrame(pid, frame, { type: "theme", payload: this.themeVars });
    }
  }

  /** Mount an iframe for binding into parent. Returns a destroy function. */
  mount(binding: PluginTabBinding, parent: HTMLElement): () => void {
    const iframe = document.createElement("iframe");
    iframe.className = "plugin-iframe";
    iframe.sandbox.add("allow-scripts");
    iframe.title = `${binding.pluginName}: ${binding.label}`;
    iframe.src = `/api/v1/plugins/${encodeURIComponent(binding.pluginName)}/ui/${binding.asset}`;
    iframe.dataset.pluginId = String(binding.pluginId);
    iframe.addEventListener("load", () => {
      this.postToFrame(binding.pluginId, iframe, { type: "theme", payload: this.themeVars });
      this.postToFrame(binding.pluginId, iframe, { type: "ready", payload: null });
    });
    parent.appendChild(iframe);
    this.frames.set(binding.pluginId, iframe);
    return () => {
      iframe.remove();
      this.frames.delete(binding.pluginId);
    };
  }

  /** Listen for messages emitted by any mounted plugin iframe. */
  onMessageEnvelope(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Send a host → plugin message. */
  send(pluginId: number, type: string, payload?: unknown): void {
    const frame = this.frames.get(pluginId);
    if (!frame) return;
    this.postToFrame(pluginId, frame, { type, payload });
  }

  private postToFrame(pluginId: number, frame: HTMLIFrameElement, msg: { type: string; payload: unknown }): void {
    frame.contentWindow?.postMessage(
      { source: HOST_ORIGIN_PREFIX, pluginId, ...msg },
      "*",
    );
  }

  /**
   * Look up the pluginId of an iframe by its contentWindow. Returns null if
   * the source is not one of our managed plugin frames. This is the key
   * defense against postMessage spoofing: we never trust the pluginId field
   * inside the message body, only the e.source pointer.
   */
  private pluginIdForSource(source: MessageEventSource | null): number | null {
    if (!source) return null;
    for (const [pid, frame] of this.frames) {
      if (frame.contentWindow === source) return pid;
    }
    return null;
  }

  private onMessage = (e: MessageEvent): void => {
    const data = e.data;
    if (!data || typeof data !== "object") return;
    if ((data as { source?: unknown }).source === HOST_ORIGIN_PREFIX) return; // own echo
    // SECURITY: validate the message originated from one of our managed
    // plugin iframes by matching e.source against frame.contentWindow.
    // Without this check, any arbitrary frame (including a malicious parent
    // frame in an embedding scenario, or any same-origin script that
    // obtained a window reference) could spoof messages from any plugin by
    // claiming an arbitrary pluginId in the body. The pluginId from the
    // message body is intentionally ignored — we use the trusted lookup.
    const trustedPluginId = this.pluginIdForSource(e.source);
    if (trustedPluginId === null) return;
    const env = data as { type?: unknown; payload?: unknown };
    if (typeof env.type !== "string") return;
    const envelope: PluginMessageEnvelope = {
      pluginId: trustedPluginId,
      type: env.type,
      payload: env.payload,
    };
    for (const l of this.listeners) {
      try {
        l(envelope);
      } catch (err) {
        console.error("plugin bridge listener threw", err);
      }
    }
  };
}

export const pluginBridge = new PluginBridge();
