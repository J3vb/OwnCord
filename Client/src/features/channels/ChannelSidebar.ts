/**
 * ChannelSidebar component — channel list sidebar with categories,
 * unread indicators, and collapse/expand behavior.
 * Voice channels show connected users; a click joins, or opens the call once joined.
 * The voice rows draw from row models (features/channels/voiceRow*.ts) that
 * one `select` over their stores keeps current; the text rows and the
 * category groups draw from models too (features/channels/channelRow*.ts).
 * This module owns the sidebar's lifetime: mount, the header, the change
 * dispatch and destroy. The inputs are `sidebarInputs.ts`, the voice rows
 * `voiceSidebarRows.ts`, the list render `channelListRender.ts`.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren } from "@lib/dom";
import type { Selection } from "@lib/ui/select";
import { enableRovingNavigation } from "@lib/ui/a11y";
import type { MountableComponent } from "@lib/text/safeRender";
import { shellText } from "../../i18n/shell";
import type { ChannelSidebarOptions } from "./channelSidebarTypes";
import { createListRenderer } from "./channelListRender";
import {
  occupiedKey,
  sameListInputs,
  sameVoiceInputs,
  selectSidebarInputs,
  type SidebarInputs,
} from "./sidebarInputs";
import { createVoiceRows } from "./voiceSidebarRows";

export type {
  ChannelReorderData,
  ChannelSidebarOptions,
  VoiceModerationCallbacks,
} from "./channelSidebarTypes";
export { buildVoiceModOptions } from "./voiceModOptions";

export function createChannelSidebar(options: ChannelSidebarOptions): MountableComponent {
  const disposable = new Disposable();
  // renderChannels() keys every row: an unchanged row is reused and its
  // listeners left alone; a replaced row's listeners must be aborted before it
  // detaches. Per-row listeners (context menu, drag handlers) therefore hold
  // their own `Disposable` (ownerByEl), NOT the sidebar-lifetime
  // `disposable.signal` — addEventListener({ signal }) keeps a detached row
  // alive via that signal's own retained "abort" listener list until it fires,
  // so a row left on the sidebar signal would be retained for the sidebar's
  // whole lifetime. Header/root listeners registered once in mount()
  // still use `disposable.signal`.
  let root: HTMLDivElement | null = null;
  let channelList: HTMLDivElement | null = null;
  let serverNameEl: HTMLSpanElement | null = null;
  /** Everything the sidebar draws, from the one `select`
   *  mount() creates. */
  let sidebarSel: Selection<SidebarInputs> | null = null;

  /**
   * Listener owners for every keyed group and row. A reused element keeps its
   * owner; a replaced or removed one has its owner aborted before it detaches,
   * so a stale element can never outlive the render that replaced it
   * — without aborting the listeners of every UNCHANGED row, which the old
   * single per-render controller did.
   */
  const ownerByEl = new WeakMap<Element, Disposable>();
  const voice = createVoiceRows(
    options,
    disposable.signal,
    ownerByEl,
    () => sidebarSel?.get().voice,
  );
  const drawList = createListRenderer({
    options,
    lifetime: disposable.signal,
    ownerByEl,
    voice,
  });

  function renderChannels(): void {
    const focus = voice.captureFocus(channelList);
    // sidebarSel exists from mount() on, which is also when channelList does.
    if (channelList !== null && sidebarSel !== null) drawList(channelList, sidebarSel.get());
    voice.restoreFocus(focus, channelList);
  }

  /** The projection changed: redraw what it touches. */
  function onInputsChange(next: SidebarInputs, prev: SidebarInputs): void {
    if (next.serverName !== prev.serverName && serverNameEl !== null) {
      setText(serverNameEl, next.serverName ?? shellText("common.serverNameFallback"));
    }
    if (!sameListInputs(next.list, prev.list)) {
      renderChannels();
      return;
    }
    // Collapsed and Hide Muted visibility follow occupancy, so a change
    // to it takes the full render; everything else (speaking, mute,
    // verification, connection, a rename) takes the cheap path.
    if (sameVoiceInputs(next.voice, prev.voice)) return;
    if (
      next.voice.currentChannelId !== prev.voice.currentChannelId ||
      occupiedKey(next.voice) !== occupiedKey(prev.voice)
    ) {
      renderChannels();
    } else {
      voice.refresh(channelList);
    }
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "channel-sidebar", "data-testid": "channel-sidebar" });

    // Created before the header and the first render, which read it (onChange
    // cannot fire synchronously), and owned by the sidebar's lifetime signal,
    // so destroy() releases it.
    sidebarSel = selectSidebarInputs(disposable.signal, onInputsChange);

    // Header
    const header = createElement("div", { class: "channel-sidebar-header" });
    serverNameEl = createElement(
      "h2",
      {},
      sidebarSel.get().serverName ?? shellText("common.serverNameFallback"),
    );
    header.appendChild(serverNameEl);

    // Channel list
    channelList = createElement("div", { class: "channel-list" });

    // One Tab stop for the whole list; ArrowUp/Down step, Enter/Space open the
    // focused channel. The listener lives on the list, which survives
    // every keyed re-render.
    enableRovingNavigation(channelList, ".channel-item", disposable.signal, "vertical");

    appendChildren(root, header, channelList);
    container.appendChild(root);

    // Initial render
    renderChannels();
  }

  function destroy(): void {
    // disposable.destroy() also releases this sidebar's hold on the shared document-level
    // drag listeners (drag-reorder.ts tracks owners by signal).
    disposable.destroy();
    voice.dispose();
    sidebarSel = null;
    if (root !== null) {
      root.remove();
      root = null;
    }
    channelList = null;
    serverNameEl = null;
  }

  return { mount, destroy };
}
