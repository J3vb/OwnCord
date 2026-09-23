/**
 * Message Request decisions (B9-6): accept, ignore, delete or block one
 * pending request, and what the inbox does with the server's answer.
 *
 * Only the server's 200 decides anything. It is applied to the store at once,
 * like a dm_request frame, so a snapshot already in flight cannot bring the
 * request back, and the frame that follows is a no-op. A 409 (decided
 * elsewhere, or a retry of a decision whose answer was lost) and a 404 (the
 * request is gone) refetch the inbox instead of guessing: a request
 * disappearing never proves it was accepted.
 *
 * The server commits a block before it moves the request, so a Block that
 * ends stale or failed may still have blocked the sender: the block list is
 * re-read rather than assumed either way.
 *
 * Accepting opens the ordinary conversation, but only once the server's
 * dm_channel_open has put it in the DM store. The DM is never synthesized
 * from the request.
 */

import type { ApiClient, ApiClientError, DmRequestDecision } from "@lib/api";
import { createElement } from "@lib/dom";
import { createModal, type ModalInstance } from "@lib/modalFactory";
import { blocksStore, setBlockedByMe, setUserBlockedByMe } from "@stores/blocks.store";
import { setActiveChannel } from "@stores/channels.store";
import { addDmChannel, clearDmUnread, dmStore, type DmChannel } from "@stores/dm.store";
import { setActiveDmUser, setSidebarMode } from "@stores/ui.store";
import { addDmToChannelsStore, dmChannelFromPayload } from "../../pages/main-page/SidebarDmHelpers";
import { messageRequestsText as t } from "../../i18n/messageRequests";
import type { MessageRequest } from "./api";
import { applyFrame } from "./store";
import { loadRequests, requestsApi } from "./sync";

export type DecisionApi = Pick<ApiClient, "decideDmRequest"> &
  Partial<Pick<ApiClient, "getDmChannels" | "listBlocks">>;

/** done: the server applied it. stale: 409/404, the inbox was refetched. failed: try again. */
export type DecisionOutcome = "done" | "stale" | "failed" | "aborted";

/**
 * A 409 or 404 from the API. Matched by name, not instanceof: a value import
 * of lib/api from this lazy chunk splits it out of the startup chunk.
 */
function isStale(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== "ApiClientError") return false;
  const { status } = err as ApiClientError;
  return status === 409 || status === 404;
}

export async function decide(
  api: DecisionApi,
  request: MessageRequest,
  decision: DmRequestDecision,
  signal: AbortSignal,
): Promise<DecisionOutcome> {
  try {
    await api.decideDmRequest(request.id, decision, signal);
  } catch (err) {
    // The view went away (closed, signed out): whatever happened, it is not ours to show.
    if (signal.aborted) return "aborted";
    if (decision === "block") refreshBlocks(api, signal);
    if (isStale(err)) {
      loadRequests(requestsApi());
      return "stale";
    }
    return "failed";
  }
  if (signal.aborted) return "aborted";
  applyFrame(request, false);
  if (decision === "block") setUserBlockedByMe(request.sender.id, true);
  return "done";
}

/** Re-read our blocks, unless a local block change or the view's end overtakes it. */
function refreshBlocks(api: DecisionApi, signal: AbortSignal): void {
  const rev = blocksStore.getState().blockedByMeRev ?? 0;
  api.listBlocks?.(signal).then(
    (r) => {
      if (!signal.aborted) setBlockedByMe(r.blocked_user_ids, rev);
    },
    // The next ready re-reads it.
    () => {},
  );
}

/** selectDmConversation without its back-path bookkeeping: the content view
 * already remembered the channel the user came from. */
function enterConversation(dm: DmChannel): void {
  setActiveDmUser(dm.isGroup ? null : dm.recipient.id);
  setSidebarMode("dms");
  clearDmUnread(dm.channelId);
  addDmToChannelsStore(dm);
  setActiveChannel(dm.channelId);
  // The conversation mounts from the channels store's notification, queued above.
  queueMicrotask(() =>
    document.querySelector<HTMLElement>('[data-testid="msg-textarea"]')?.focus(),
  );
}

/**
 * Open the accepted conversation once the server has opened it: from its
 * dm_channel_open, or from GET /dms when that frame was lost (a resume gets
 * no ready to carry it). Dropped when `signal` aborts.
 */
export function openAcceptedConversation(
  channelId: number,
  api: DecisionApi,
  signal: AbortSignal,
): void {
  const find = (): DmChannel | undefined =>
    dmStore.getState().channels.find((c) => c.channelId === channelId);
  const dm = find();
  if (dm !== undefined) {
    enterConversation(dm);
    return;
  }
  const unsub = dmStore.subscribe(() => {
    const found = find();
    if (found === undefined || signal.aborted) return;
    unsub();
    enterConversation(found);
  });
  signal.addEventListener("abort", unsub, { once: true });
  api.getDmChannels?.(signal).then(
    (r) => {
      const p = r.dm_channels.find((d) => d.channel_id === channelId);
      if (p !== undefined && !signal.aborted) addDmChannel(dmChannelFromPayload(p));
    },
    // The frame, or the next ready, still opens it while the view is open.
    () => {},
  );
}

/** Each confirm's copy. */
const CONFIRM = {
  delete: {
    heading: "confirm.delete.title",
    body: "confirm.delete.body",
    confirm: "confirm.delete.confirm",
  },
  block: {
    heading: "confirm.block.title",
    body: "confirm.block.body",
    confirm: "confirm.block.confirm",
  },
} as const;

/**
 * The destructive-action confirm (DeleteChannelModal's shape): Cancel first
 * and focused, Escape and the backdrop cancel, focus returns to the opener.
 */
export function confirmDecision(
  request: MessageRequest,
  decision: "delete" | "block",
  name: string,
  signal: AbortSignal,
  on: { readonly onConfirm: () => void; readonly onClose: () => void },
): ModalInstance {
  const titleId = `request-confirm-title-${request.id}`;
  const content = createElement("div");
  const header = createElement("div", { class: "modal-header" });
  header.appendChild(createElement("h3", { id: titleId }, t(CONFIRM[decision].heading, { name })));
  const body = createElement("div", { class: "modal-body" });
  body.appendChild(
    createElement("p", { class: "modal-danger-text" }, t(CONFIRM[decision].body, { name })),
  );
  const footer = createElement("div", { class: "modal-footer" });
  const cancel = createElement(
    "button",
    { class: "btn-modal-cancel", type: "button", "data-testid": "request-confirm-cancel" },
    t("confirm.cancel"),
  );
  const confirm = createElement(
    "button",
    { class: "btn-danger", type: "button", "data-testid": "request-confirm" },
    t(CONFIRM[decision].confirm),
  );
  footer.append(cancel, confirm);
  content.append(header, body, footer);

  const modal = createModal({
    content,
    ariaLabelledBy: titleId,
    overlayAttrs: { "data-testid": "request-confirm-dialog" },
    signal,
    onClose: on.onClose,
  });
  cancel.addEventListener("click", () => modal.close());
  confirm.addEventListener("click", () => {
    modal.close();
    on.onConfirm();
  });
  return modal;
}
