import { reportListScroll } from "../profiles/avatar";

/** Listens to `scroller` and tells the avatar loader how fast it moves. */
export function listenForFlyingScroll(
  scroller: HTMLElement,
  signal: AbortSignal,
  onScroll: () => void,
): void {
  let lastTop = scroller.scrollTop;
  let lastAt = performance.now();
  scroller.addEventListener(
    "scroll",
    () => {
      const now = performance.now();
      reportListScroll(scroller.scrollTop - lastTop, now - lastAt, scroller.clientHeight);
      lastTop = scroller.scrollTop;
      lastAt = now;
      onScroll();
    },
    { passive: true, signal },
  );
}
