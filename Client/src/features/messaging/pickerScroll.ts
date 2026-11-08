/** Cache category geometry so scrolling never measures every emoji group. */
export function trackPickerCategory(
  scrollArea: HTMLElement,
  categoryBar: HTMLElement,
  signal: AbortSignal,
): () => void {
  let positions: Array<{ name: string | undefined; top: number }> | null = null;
  let current: string | undefined;
  let frame: number | null = null;

  function sync(): void {
    positions ??= [...scrollArea.querySelectorAll<HTMLElement>(".ep-category-label")].map(
      (label) => ({ name: label.dataset.category, top: label.offsetTop }),
    );
    const top = scrollArea.scrollTop + 1;
    let next = positions[0]?.name;
    for (const position of positions) {
      if (position.top > top) break;
      next = position.name;
    }
    if (next === current) return;
    current = next;
    for (const btn of categoryBar.querySelectorAll<HTMLElement>(".ep-category-btn")) {
      btn.classList.toggle("active", btn.dataset.category === current);
    }
  }

  function schedule(): void {
    if (frame !== null || signal.aborted) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!signal.aborted) sync();
    });
  }

  function refresh(): void {
    positions = null;
    current = undefined;
    schedule();
  }

  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refresh);
  resizeObserver?.observe(scrollArea);
  scrollArea.addEventListener("scroll", schedule, { signal, passive: true });
  signal.addEventListener(
    "abort",
    () => {
      if (frame !== null) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      positions = null;
    },
    { once: true },
  );
  return refresh;
}
