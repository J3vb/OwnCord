/**
 * Block / Unblock as one action every surface shares (WP 3B-2): the member
 * list, the profile popup, the DM profile panel and the DM row menu all end in
 * `toggleBlock`, and the three that did not already confirm go through
 * `confirmAndToggleBlock` first.
 *
 * Only the server's answer changes `blocksStore`: a failed request leaves the
 * store, and so every Block/Unblock label, as it was. A second request for the
 * same user while one is in flight is dropped, so a double-click on a confirm
 * button sends one PUT/DELETE.
 */

import { errorText, type ApiClient } from "@lib/api";
import { createElement } from "@lib/dom";
import { createModal } from "@lib/modalFactory";
import { setUserBlockedByMe } from "@stores/blocks.store";
import type { ToastType } from "@components/Toast";
import { messageRequestsText as t } from "../../i18n/messageRequests";
import { shellText } from "../../i18n/shell";

export interface BlockDeps {
  readonly api: Pick<ApiClient, "blockUser" | "unblockUser">;
  readonly notify: (message: string, type: ToastType) => void;
}

/** Users with a block or unblock request in flight. */
const inFlight = new Set<number>();

/** PUT or DELETE the block, then mirror the answer into the store and toast. */
export async function toggleBlock(
  deps: BlockDeps,
  userId: number,
  username: string,
  block: boolean,
): Promise<void> {
  if (inFlight.has(userId)) return;
  inFlight.add(userId);
  try {
    if (block) {
      await deps.api.blockUser(userId);
    } else {
      await deps.api.unblockUser(userId);
    }
    setUserBlockedByMe(userId, block);
    deps.notify(
      shellText(block ? "members.blocked" : "members.unblocked", { username }),
      "success",
    );
  } catch (err) {
    const fallback = shellText(block ? "members.blockFailed" : "members.unblockFailed");
    deps.notify(errorText(err, fallback), "error");
  } finally {
    inFlight.delete(userId);
  }
}

/** The destructive-action confirm (DeleteChannelModal's shape): Cancel first,
 *  Escape and the backdrop cancel, focus returns to the opener. */
function confirmBlockModal(name: string, onConfirm: () => void): void {
  const titleId = "block-confirm-title";
  const content = createElement("div");
  const header = createElement("div", { class: "modal-header" });
  header.appendChild(createElement("h3", { id: titleId }, t("confirm.block.title", { name })));
  const body = createElement("div", { class: "modal-body" });
  body.appendChild(
    createElement("p", { class: "modal-danger-text" }, t("confirm.blockUser.body", { name })),
  );
  const footer = createElement("div", { class: "modal-footer" });
  const cancel = createElement(
    "button",
    { class: "btn-modal-cancel", type: "button", "data-testid": "block-confirm-cancel" },
    t("confirm.cancel"),
  );
  const confirm = createElement(
    "button",
    { class: "btn-danger", type: "button", "data-testid": "block-confirm" },
    t("confirm.block.confirm"),
  );
  footer.append(cancel, confirm);
  content.append(header, body, footer);
  const modal = createModal({
    content,
    ariaLabelledBy: titleId,
    overlayAttrs: { "data-testid": "block-confirm-dialog" },
  });
  cancel.addEventListener("click", () => modal.close());
  confirm.addEventListener("click", () => {
    modal.close();
    onConfirm();
  });
}

/** Block asks first, because it silences DMs both ways; Unblock is one click. */
export function confirmAndToggleBlock(
  deps: BlockDeps,
  userId: number,
  username: string,
  block: boolean,
): void {
  if (!block) {
    void toggleBlock(deps, userId, username, false);
    return;
  }
  confirmBlockModal(username, () => void toggleBlock(deps, userId, username, true));
}
