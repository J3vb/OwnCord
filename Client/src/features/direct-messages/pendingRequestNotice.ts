/**
 * The sender's side of a message request that may still be waiting: a notice
 * above the composer of that DM, and a hint in its call buttons' tooltips.
 * Only a hint: the buttons keep working, because this copy of the state can
 * lag (an acceptance reaches the sender as no frame at all). Follows
 * `pendingRequestsStore` and the open channel live.
 */
import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { channelsStore } from "@stores/channels.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { requestsText } from "../../i18n/requests";
import { pendingRequestsStore, isRequestPending } from "./pendingRequests";

export interface PendingRequestNoticeOptions {
  /** The composer's slot; the notice sits just above it. */
  readonly inputSlot: HTMLElement;
  /** The DM header's voice and video call buttons. */
  readonly callButtons: readonly HTMLButtonElement[];
}

/** The other person's name when the open DM may wait on this user's request. */
function waitingFor(): string | null {
  const channelId = channelsStore.getState().activeChannelId;
  if (channelId === null || !isRequestPending(channelId)) return null;
  const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
  if (dm === undefined || dm.isGroup) return null;
  return dmDisplayName(dm);
}

function buildNotice(name: string): HTMLElement {
  const box = createElement("div", { class: "dm-pending-request" });
  const text = createElement("span", { class: "dm-pending-request-text" });
  const title = createElement("strong", {}, requestsText("dm.requestPending", { name }));
  appendChildren(text, title, " ", requestsText("dm.requestPendingCalls"));
  appendChildren(box, createIcon("clock", 18), text);
  return box;
}

/** Mount the notice and start following the stores; returns its teardown. */
export function mountPendingRequestNotice(opts: PendingRequestNoticeOptions): () => void {
  // The live region stays in the page, empty, so filling it is announced.
  const region = createElement("div", {
    role: "status",
    "data-testid": "dm-pending-request",
  });
  opts.inputSlot.before(region);

  const defaults = opts.callButtons.map((btn) => btn.title);
  let shown: string | null = null;

  const sync = (): void => {
    const name = waitingFor();
    if (name !== shown) {
      shown = name;
      region.replaceChildren(...(name === null ? [] : [buildNotice(name)]));
    }
    opts.callButtons.forEach((btn, i) => {
      const action = defaults[i] ?? "";
      btn.title =
        name === null ? action : requestsText("dm.requestPendingCallTitle", { action, name });
    });
  };

  const unsubs = [
    pendingRequestsStore.subscribe(sync),
    channelsStore.subscribeSelector((s) => s.activeChannelId, sync),
    dmStore.subscribeSelector((s) => s.channels, sync),
  ];
  sync();

  return () => {
    for (const unsub of unsubs) unsub();
    region.remove();
    opts.callButtons.forEach((btn, i) => {
      btn.title = defaults[i] ?? "";
    });
  };
}
