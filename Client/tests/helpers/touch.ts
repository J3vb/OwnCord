// Touch pointer events for the swipe tests. jsdom's PointerEvent defaults
// isPrimary to false and pointerType to "", so both are always spelled out.

export interface TouchInit {
  readonly pointerId?: number;
  readonly pointerType?: string;
  readonly isPrimary?: boolean;
}

export function pointer(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  target: Element,
  x: number,
  y: number,
  init: TouchInit = {},
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerId: init.pointerId ?? 1,
      pointerType: init.pointerType ?? "touch",
      isPrimary: init.isPrimary ?? true,
    }),
  );
}

/** A finger down at (x0, y0), moved to (x1, y1) in a few steps, and lifted. */
export function swipe(
  target: Element,
  from: readonly [number, number],
  to: readonly [number, number],
  init: TouchInit = {},
): void {
  pointer("pointerdown", target, from[0], from[1], init);
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps;
    const y = from[1] + ((to[1] - from[1]) * i) / steps;
    pointer("pointermove", target, x, y, init);
  }
  pointer("pointerup", target, to[0], to[1], init);
}
