/**
 * CategoryModals — the two dialogs of category management (WP 6.5b): a name
 * prompt that serves Create and Rename, and the Delete confirmation. They
 * follow DeleteChannelModal's shape: the caller owns the request and the toast,
 * the dialog only re-arms its button and shows the inline error when the
 * caller's promise rejects. They load on first use (SidebarArea), so neither
 * is in the main-page chunk.
 */

import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/ime";
import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { closeOnBackdropClick, createModal, type ModalInstance } from "@lib/modalFactory";
import type { MountableComponent } from "@lib/safe-render";
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
  const disposable = new Disposable();
  let instance: ModalInstance | null = null;

  function mount(container: Element): void {
    const body = createElement("div", { class: "modal-body" });
    const warning = createElement("div", { class: "modal-danger-text" });
    // The name stays data inside one translatable sentence: split at a marker
    // the parameter can never contain.
    const [before = "", after = ""] = shellText("category.deleteWarning", {
      category: "\u0000",
    }).split("\u0000");
    appendChildren(warning, before, createElement("strong", {}, categoryName), after);
    const errorEl = createElement("div", {
      style: "color: var(--text-danger); font-size: 13px; display: none; margin-top: 8px;",
      "data-testid": "delete-category-error",
    });
    appendChildren(body, warning, errorEl);

    const footer = createElement("div", { class: "modal-footer" });
    const cancelBtn = createElement(
      "button",
      { class: "btn-modal-cancel", type: "button" },
      shellText("common.cancel"),
    );
    cancelBtn.addEventListener("click", onClose, { signal: disposable.signal });
    const deleteBtn = createElement(
      "button",
      { class: "btn-danger", type: "button", "data-testid": "delete-category-confirm" },
      shellText("category.delete"),
    );
    deleteBtn.addEventListener(
      "click",
      async () => {
        deleteBtn.setAttribute("disabled", "true");
        setText(deleteBtn, shellText("common.deleting"));
        try {
          await onConfirm();
        } catch (err) {
          errorEl.style.display = "block";
          setText(errorEl, categoryErrorText(err, shellText("category.deleteFailed")));
        } finally {
          if (instance?.overlay.isConnected === true) {
            deleteBtn.removeAttribute("disabled");
            setText(deleteBtn, shellText("category.delete"));
          }
        }
      },
      { signal: disposable.signal },
    );
    appendChildren(footer, cancelBtn, deleteBtn);

    instance = openDialog(container, disposable, {
      titleId: "delete-category-title",
      title: shellText("category.delete"),
      testId: "delete-category-modal",
      body,
      footer,
      onClose,
    });
  }

  function destroy(): void {
    disposable.destroy();
    instance?.destroy();
    instance = null;
  }

  return { mount, destroy };
}
