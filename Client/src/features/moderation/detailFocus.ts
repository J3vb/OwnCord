/**
 * Focus carry-over for the Moderation Center's detail panes. A re-read
 * rebuilds the whole report or appeal, so the control that held focus (and the
 * caret in a text field) is noted first and put back on the same control in
 * the new view.
 */

export interface DetailFocus {
  readonly hadFocus: boolean;
  readonly retryHadFocus: boolean;
  /** The `data-focus` key of the control that held focus inside the pane. */
  readonly focusKey: string | undefined;
  readonly caret: readonly [number | null, number | null] | null;
}

/** Whether `el` is a field whose caret is worth keeping; `withTextInputs` adds one-line text inputs. */
function holdsCaret(el: Element | null, withTextInputs: boolean): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  return withTextInputs && el instanceof HTMLInputElement && el.type === "text";
}

export function captureDetailFocus(
  slot: HTMLElement,
  retry: HTMLElement,
  withTextInputs: boolean,
): DetailFocus {
  const active = document.activeElement;
  const hadFocus = slot.contains(active);
  const retryHadFocus = active === retry;
  const focusKey = hadFocus && active instanceof HTMLElement ? active.dataset.focus : undefined;
  const caret =
    holdsCaret(active, withTextInputs) &&
    (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)
      ? ([active.selectionStart, active.selectionEnd] as const)
      : null;
  return { hadFocus, retryHadFocus, focusKey, caret };
}

export function restoreDetailFocus(
  view: { readonly element: HTMLElement; readonly heading: HTMLElement },
  before: DetailFocus,
  takeFocus: boolean,
  withTextInputs: boolean,
): void {
  const again =
    before.focusKey === undefined || takeFocus
      ? null
      : view.element.querySelector<HTMLElement>(`[data-focus="${before.focusKey}"]`);
  if (again === null) {
    if (takeFocus || before.hadFocus || before.retryHadFocus) view.heading.focus();
    return;
  }
  again.focus();
  const { caret } = before;
  if (caret === null) return;
  // Any input takes the caret back, as it did before the carry-over moved here.
  if (
    again instanceof HTMLTextAreaElement ||
    (withTextInputs && again instanceof HTMLInputElement)
  ) {
    again.setSelectionRange(caret[0], caret[1]);
  }
}
