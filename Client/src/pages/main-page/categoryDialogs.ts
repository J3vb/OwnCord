/**
 * The sidebar's category management dialogs: Create, Rename and
 * Delete open a dialog in the sidebar's one modal slot, Move needs none. The
 * dialogs load on first use (`CategoryModals`), so they stay out of the
 * main-page chunk. Every REST call goes through `features/channels/
 * categoryActions`, which toasts a failure and rethrows it for the dialog's own
 * inline error. Nothing here writes a store: the result arrives as
 * `channel_update` / `channel_categories` frames.
 */

import { createLazyScreen } from "@components/lazyScreen";
import type { MountableComponent } from "@lib/safe-render";
import type { CategoryRef } from "@stores/channels.store";
import {
  createCategory,
  deleteCategory,
  moveCategory,
  placeCategory,
  renameCategory,
  type CategoryApi,
  type CategoryToast,
} from "../../features/channels/categoryActions";

const categoryModalsScreen = createLazyScreen(
  "category-modals",
  () => import("@components/CategoryModals"),
);

/** The sidebar's single modal slot, shared with the channel dialogs. */
export interface ModalSlot {
  current(): MountableComponent | null;
  set(modal: MountableComponent | null): void;
}

export interface CategoryDialogs {
  readonly create: () => void;
  readonly rename: (category: CategoryRef) => void;
  readonly remove: (category: CategoryRef) => void;
  readonly move: (category: CategoryRef, direction: -1 | 1) => void;
  /** A dragged header dropped before or after another. */
  readonly place: (categoryId: number, targetId: number, before: boolean) => void;
}

export function createCategoryDialogs(deps: {
  readonly api: CategoryApi;
  readonly getToast: () => CategoryToast | null;
  readonly slot: ModalSlot;
}): CategoryDialogs {
  const { api, getToast, slot } = deps;

  /** Load the dialogs module while a placeholder holds the slot, then mount what `build` makes. */
  function open(
    build: (
      screen: typeof import("@components/CategoryModals"),
      close: () => void,
    ) => MountableComponent,
  ): void {
    if (slot.current() !== null) return;
    // A second click is refused while the dialog loads, and a teardown or
    // another modal in between drops the late one (as the channel dialogs do).
    const pending: MountableComponent = { mount: () => {} };
    slot.set(pending);
    void categoryModalsScreen
      .load(() => slot.current() === pending)
      .then((screen) => {
        if (screen === null) {
          if (slot.current() === pending) slot.set(null);
          return;
        }
        if (slot.current() !== pending) return;
        let modal: MountableComponent | null = null;
        const close = (): void => {
          modal?.destroy?.();
          slot.set(null);
        };
        modal = build(screen, close);
        slot.set(modal);
        modal.mount(document.body);
      });
  }

  return {
    create: () =>
      open((screen, close) =>
        screen.createCategoryNameModal({
          mode: "create",
          initialName: "",
          onSubmit: async (name) => {
            await createCategory(api, getToast, name);
            close();
          },
          onClose: close,
        }),
      ),
    rename: (category) =>
      open((screen, close) =>
        screen.createCategoryNameModal({
          mode: "rename",
          initialName: category.name,
          onSubmit: async (name) => {
            await renameCategory(api, getToast, category.id, name);
            close();
          },
          onClose: close,
        }),
      ),
    remove: (category) =>
      open((screen, close) =>
        screen.createDeleteCategoryModal({
          categoryName: category.name,
          onConfirm: async () => {
            await deleteCategory(api, getToast, category.id);
            close();
          },
          onClose: close,
        }),
      ),
    move: (category, direction) => {
      void moveCategory(api, getToast, category.id, direction);
    },
    place: (categoryId, targetId, before) => {
      void placeCategory(api, getToast, categoryId, targetId, before);
    },
  };
}
