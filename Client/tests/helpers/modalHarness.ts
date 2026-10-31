import { expect, vi, type Mock } from "vitest";

/** The spies a dialog probe hands to a suite's own `makeModal`. */
export interface DialogSpies {
  readonly action: Mock;
  readonly onClose: Mock;
}

export interface DialogHandle {
  destroy?(): void;
}

/** Builds and mounts the modal under test with the given confirm/close spies. */
export type MakeDialog = (spies: DialogSpies) => DialogHandle;

function spies(): DialogSpies {
  return { action: vi.fn(async () => {}), onClose: vi.fn() };
}

function pressEscape(init: KeyboardEventInit = {}): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", ...init }));
}

export function checkEscapeCancels(make: MakeDialog): void {
  const s = spies();
  const modal = make(s);

  pressEscape();

  expect(s.onClose).toHaveBeenCalledTimes(1);
  expect(s.action).not.toHaveBeenCalled();
  modal.destroy?.();
}

export function checkEscapeKeepsImeCandidate(make: MakeDialog): void {
  const s = spies();
  const modal = make(s);

  pressEscape({ isComposing: true, bubbles: true });
  expect(s.onClose).not.toHaveBeenCalled();
  pressEscape();
  expect(s.onClose).toHaveBeenCalledTimes(1);
  modal.destroy?.();
}

export function checkEscapeIgnoredAfterDestroy(make: MakeDialog): void {
  const s = spies();
  const modal = make(s);
  modal.destroy?.();

  pressEscape();

  expect(s.onClose).not.toHaveBeenCalled();
}

export function checkClickCloses(make: MakeDialog, container: ParentNode, selector: string): void {
  const s = spies();
  const modal = make(s);
  (container.querySelector(selector) as HTMLElement).click();
  expect(s.onClose).toHaveBeenCalled();
  modal.destroy?.();
}

export function checkBackdropClickCloses(
  make: MakeDialog,
  container: ParentNode,
  overlaySelector: string,
): void {
  const s = spies();
  const modal = make(s);

  const overlay = container.querySelector(overlaySelector) as HTMLDivElement;
  overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  expect(s.onClose).toHaveBeenCalled();
  modal.destroy?.();
}

export function checkDragSelectKeepsOpen(
  make: MakeDialog,
  container: ParentNode,
  overlaySelector: string,
): void {
  const s = spies();
  const modal = make(s);
  const overlayEl = container.querySelector(overlaySelector) as HTMLElement;
  overlayEl.firstElementChild!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  overlayEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(s.onClose).not.toHaveBeenCalled();
  modal.destroy?.();
}

export function checkOverlayRemovedOnDestroy(
  make: MakeDialog,
  container: ParentNode,
  overlaySelector: string,
): void {
  const modal = make(spies());
  expect(container.querySelector(overlaySelector)).not.toBeNull();
  modal.destroy?.();
  expect(container.querySelector(overlaySelector)).toBeNull();
}
