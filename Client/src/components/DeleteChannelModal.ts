/**
 * DeleteChannelModal — confirmation dialog for deleting a channel.
 * Shows channel name and requires explicit confirmation. A thin
 * MountableComponent over the shared confirm preset (features/dialogs/confirmModal.ts):
 * Cancel focused, Escape and the backdrop cancel, and a rejected `onConfirm`
 * shows the inline error and re-arms the button.
 */

import { createElement, appendChildren } from "@lib/dom";
import { createConfirmModal, type ConfirmModalInstance } from "../features/dialogs/confirmModal";
import { errorText } from "@lib/api";
import type { MountableComponent } from "@lib/text/safeRender";
import { shellText } from "../i18n/shell";

export interface DeleteChannelModalOptions {
  readonly channelId: number;
  readonly channelName: string;
  readonly onConfirm: () => Promise<void>;
  readonly onClose: () => void;
}

export function createDeleteChannelModal(options: DeleteChannelModalOptions): MountableComponent {
  const { channelName, onConfirm, onClose } = options;
  let instance: ConfirmModalInstance | null = null;
  // destroy() is the owner tearing the dialog down; it must not call back into
  // the owner's own onClose (which would destroy again and clear its slot).
  let destroying = false;

  function mount(container: Element): void {
    const warning = createElement("div", { class: "modal-danger-text" });
    // One message around the emphasised channel name: split at a marker the
    // parameter can never contain, so the name stays data and the sentence
    // stays whole for translation.
    const [before = "", after = ""] = shellText("channel.deleteWarning", {
      channel: "\u0000",
    }).split("\u0000");
    appendChildren(warning, before, createElement("strong", {}, `#${channelName}`), after);

    instance = createConfirmModal(
      {
        title: shellText("channel.delete"),
        titleId: "delete-channel-title",
        body: warning,
        confirmLabel: shellText("channel.delete"),
        cancelLabel: shellText("common.cancel"),
        closeButton: true,
        testId: "delete-channel-modal",
        confirmTestId: "delete-channel-confirm",
        errorTestId: "delete-channel-error",
        // The caller closes the dialog itself: a successful delete destroys it
        // inside onConfirm.
        onConfirm,
        staysOpen: true,
        closeOnResolve: false,
        busyLabel: shellText("common.deleting"),
        failureText: (err) => errorText(err, shellText("channel.deleteFailed")),
        onClose: () => {
          if (!destroying) onClose();
        },
      },
      container,
    );
  }

  function destroy(): void {
    destroying = true;
    instance?.destroy();
    instance = null;
  }

  return { mount, destroy };
}
