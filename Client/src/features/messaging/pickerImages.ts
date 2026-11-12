/** Load visible picker images first, with a small buffer ahead of scrolling. */
const PREFETCH_PX = 320;
const MAX_ACTIVE = 4;

interface PendingImage {
  readonly load: () => Promise<string | null>;
  readonly show: (src: string) => void;
  nearby: boolean;
  distance: number;
}

export interface PickerImages {
  observe(
    img: HTMLImageElement,
    load: () => Promise<string | null>,
    show?: (src: string) => void,
  ): void;
  clear(): void;
}

export function createPickerImages(root: HTMLElement, signal: AbortSignal): PickerImages {
  const pending = new Map<HTMLImageElement, PendingImage>();
  let active = 0;
  let generation = 0;

  const observer =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const item = pending.get(entry.target as HTMLImageElement);
              if (item === undefined) continue;
              item.nearby = entry.isIntersecting;
              const bounds = entry.rootBounds;
              item.distance =
                bounds === null
                  ? 0
                  : Math.max(
                      bounds.top + PREFETCH_PX - entry.boundingClientRect.bottom,
                      entry.boundingClientRect.top - (bounds.bottom - PREFETCH_PX),
                      0,
                    );
            }
            drain();
          },
          { root, rootMargin: `${PREFETCH_PX}px 0px` },
        );

  function nextImage(): [HTMLImageElement, PendingImage] | undefined {
    let best: [HTMLImageElement, PendingImage] | undefined;
    for (const candidate of pending) {
      if (!candidate[1].nearby) continue;
      if (best === undefined || candidate[1].distance < best[1].distance) best = candidate;
    }
    return best;
  }

  async function loadImage(img: HTMLImageElement, item: PendingImage): Promise<void> {
    const mine = generation;
    try {
      const src = await item.load();
      if (src !== null && !signal.aborted && mine === generation && root.contains(img)) {
        item.show(src);
      }
    } catch {
      // Keep the image's alt text when a preview cannot be fetched.
    } finally {
      active--;
      drain();
    }
  }

  function drain(): void {
    while (!signal.aborted && active < MAX_ACTIVE) {
      const next = nextImage();
      if (next === undefined) return;
      const [img, item] = next;
      pending.delete(img);
      observer?.unobserve(img);
      active++;
      void loadImage(img, item);
    }
  }

  function clear(): void {
    generation++;
    pending.clear();
    observer?.disconnect();
  }
  signal.addEventListener("abort", clear, { once: true });

  return {
    observe(
      img,
      load,
      show = (src) => {
        img.src = src;
      },
    ) {
      if (signal.aborted) return;
      pending.set(img, { load, show, nearby: observer === null, distance: 0 });
      if (observer === null) drain();
      else observer.observe(img);
    },
    clear,
  };
}
