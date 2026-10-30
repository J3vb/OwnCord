/**
 * CategoryModals — the two dialogs of category management: a name
 * prompt that serves Create and Rename, and the Delete confirmation. They
 * follow DeleteChannelModal's shape: the caller owns the request and the toast,
 * the dialog only re-arms its button and shows the inline error when the
 * caller's promise rejects. The Delete confirmation is the shared confirm
 * preset (features/dialogs/confirmModal.ts); the name prompt keeps its own form
 * shell. They load on first use (SidebarArea), so neither is in the main-page
 * chunk.
 */

import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/text/ime";
import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { closeOnBackdropClick, createModal, type ModalInstance } from "@lib/modalFactory";
import { createConfirmModal, type ConfirmModalInstance } from "../features/dialogs/confirmModal";
import type { MountableComponent } from "@lib/text/safeRender";
import { shellText } from "../i18n/shell";
import { categoryErrorText } from "../features/channels/categoryActions";

/** The server's cap on a category name (docs/api.md, "Categories"). */
export const MAX_CATEGORY_NAME_LENGTH = 100;

export interface CategoryNameModalOptions {
  readonly mode: "create" | "rename";
  /** The current name when renaming; "" when creating. */
  readonly initialName: string;
  readonly onSubmit: (name: string) => Promise<void>;
  readonly onClose: () => void;
}

/** Shared shell: header with a close button, a body, a footer; Escape and the backdrop cancel. */
function openDialog(
  container: Element,
  disposable: Disposable,
  parts: {
    readonly titleId: string;
    readonly title: string;
    readonly testId: string;
    readonly body: HTMLElement;
    readonly footer: HTMLElement;
    readonly onClose: () => void;
  },
): ModalInstance {
  const header = createElement("div", { class: "modal-header" });
  const title = createElement("h3", { id: parts.titleId }, parts.title);
  const closeBtn = createElement("button", {
    class: "modal-close",
    type: "button",
    "aria-label": shellText("common.close"),
  });
  closeBtn.appendChild(createIcon("x", 14));
  closeBtn.addEventListener("click", parts.onClose, { signal: disposable.signal });
  appendChildren(header, title, closeBtn);

  const instance = createModal(
    {
      content: header,
      closeOnBackdrop: false,
      // Escape cancels and never confirms.
      onEscape: () => parts.onClose(),
      overlayAttrs: { "data-testid": parts.testId },
      ariaLabelledBy: parts.titleId,
    },
    container,
  );
  appendChildren(instance.modal, parts.body, parts.footer);
  closeOnBackdropClick(instance.overlay, () => parts.onClose(), disposable.signal);
  return instance;
}

export function createCategoryNameModal(options: CategoryNameModalOptions): MountableComponent {
  const { mode, initialName, onSubmit, onClose } = options;
  const disposable = new Disposable();
  let instance: ModalInstance | null = null;
  const submitLabel = shellText(mode === "create" ? "category.create" : "category.rename");
  const failedLabel = shellText(
    mode === "create" ? "category.createFailed" : "category.renameFailed",
  );

  function mount(container: Element): void {
    const body = createElement("div", { class: "modal-body" });
    const group = createElement("div", { class: "form-group" });
    const label = createElement(
      "label",
      { class: "form-label", for: "category-name-input" },
      shellText("category.name"),
    );
    const input = createElement("input", {
      id: "category-name-input",
      class: "form-input",
      type: "text",
      autocomplete: "off",
      maxlength: String(MAX_CATEGORY_NAME_LENGTH),
      placeholder: shellText("category.namePlaceholder"),
      "data-testid": "category-name-input",
    });
    input.value = initialName;
    appendChildren(group, label, input);
    const errorEl = createElement("div", {
      class: "form-group",
      style: "color: var(--text-danger); font-size: 13px; display: none;",
      "data-testid": "category-name-error",
    });
    appendChildren(body, group, errorEl);

    const footer = createElement("div", { class: "modal-footer" });
    const cancelBtn = createElement(
      "button",
      { class: "btn-modal-cancel", type: "button" },
      shellText("common.cancel"),
    );
    cancelBtn.addEventListener("click", onClose, { signal: disposable.signal });
    const saveBtn = createElement(
      "button",
      { class: "btn-modal-save", type: "button", "data-testid": "category-name-submit" },
      submitLabel,
    );

    const submit = async (): Promise<void> => {
      const name = input.value.trim();
      if (name === "") {
        errorEl.style.display = "block";
        setText(errorEl, shellText("category.nameRequired"));
        input.classList.add("error");
        return;
      }
      // Unchanged on rename: nothing to send.
      if (mode === "rename" && name === initialName) {
        onClose();
        return;
      }
      errorEl.style.display = "none";
      input.classList.remove("error");
      saveBtn.setAttribute("disabled", "true");
      setText(saveBtn, shellText(mode === "create" ? "category.creating" : "category.saving"));
      try {
        await onSubmit(name);
      } catch (err) {
        errorEl.style.display = "block";
        setText(errorEl, categoryErrorText(err, failedLabel));
      } finally {
        // A success destroys the modal inside onSubmit, so this no-ops then.
        if (instance?.overlay.isConnected === true) {
          saveBtn.removeAttribute("disabled");
          setText(saveBtn, submitLabel);
        }
      }
    };
    saveBtn.addEventListener("click", () => void submit(), { signal: disposable.signal });
    // Enter submits, but not while an IME is composing (Enter confirms the candidate).
    input.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key !== "Enter" || isImeCommit(e)) return;
        if (saveBtn.hasAttribute("disabled")) return;
        e.preventDefault();
        void submit();
      },
      { signal: disposable.signal },
    );
    appendChildren(footer, cancelBtn, saveBtn);

    instance = openDialog(container, disposable, {
      titleId: "category-name-title",
      title: submitLabel,
      testId: mode === "create" ? "create-category-modal" : "rename-category-modal",
      body,
      footer,
      onClose,
    });
    input.focus();
    input.select();
  }

  function destroy(): void {
    disposable.destroy();
    instance?.destroy();
    instance = null;
  }

  return { mount, destroy };
}

export interface DeleteCategoryModalOptions {
  readonly categoryName: string;
  readonly onConfirm: () => Promise<void>;
  readonly onClose: () => void;
}

export function createDeleteCategoryModal(options: DeleteCategoryModalOptions): MountableComponent {
  const { categoryName, onConfirm, onClose } = options;
  let instance: ConfirmModalInstance | null = null;
  // destroy() is the owner tearing the dialog down; it must not call back into
  // the owner's own onClose (which would destroy again and clear its slot).
  let destroying = false;

  function mount(container: Element): void {
    const warning = createElement("div", { class: "modal-danger-text" });
    // The name stays data inside one translatable sentence: split at a marker
    // the parameter can never contain.
    const [before = "", after = ""] = shellText("category.deleteWarning", {
      category: "\u0000",
    }).split("\u0000");
    appendChildren(warning, before, createElement("strong", {}, categoryName), after);

    // The shared confirm preset: Cancel focused, Escape and the backdrop
    // cancel, a rejected request shows the inline error and re-arms the button.
    instance = createConfirmModal(
      {
        title: shellText("category.delete"),
        titleId: "delete-category-title",
        body: warning,
        confirmLabel: shellText("category.delete"),
        cancelLabel: shellText("common.cancel"),
        closeButton: true,
        testId: "delete-category-modal",
        confirmTestId: "delete-category-confirm",
        errorTestId: "delete-category-error",
        // The caller closes the dialog itself: a success destroys it inside
        // onConfirm.
        onConfirm,
        staysOpen: true,
        closeOnResolve: false,
        busyLabel: shellText("common.deleting"),
        failureText: (err) => categoryErrorText(err, shellText("category.deleteFailed")),
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
