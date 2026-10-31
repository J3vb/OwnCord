/** Dispatches the Enter keydown an input method sends to commit a composition. */
export function pressComposingEnter(target: EventTarget): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}
