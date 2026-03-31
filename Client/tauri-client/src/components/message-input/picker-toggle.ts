/**
 * Reusable picker toggle — manages open/close/click-outside lifecycle
 * for floating panels (emoji picker, GIF picker, etc.).
 */

export interface PickerInstance {
  readonly element: HTMLDivElement;
  destroy(): void;
}

export interface PickerToggleOptions {
  /** Creates and returns a new picker instance. */
  readonly create: () => PickerInstance;
  /** The trigger button element — clicks on it won't close the picker. */
  readonly triggerEl: HTMLElement;
  /** Parent element to append the picker to. */
  readonly parentEl: HTMLElement | null;
  /** Called before opening — use to close other pickers first. */
  readonly onBeforeOpen?: () => void;
  /** Timer set for deferred cleanup. */
  readonly activeTimers: Set<ReturnType<typeof setTimeout>>;
}

export interface PickerToggleHandle {
  toggle(): void;
  close(): void;
}

export function createPickerToggle(opts: PickerToggleOptions): PickerToggleHandle {
  let instance: PickerInstance | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  function handleClickOutside(e: MouseEvent): void {
    if (instance === null) return;
    const target = e.target as Node;
    if (!instance.element.contains(target) && target !== opts.triggerEl && !opts.triggerEl.contains(target)) {
      close();
    }
  }

  function close(): void {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      opts.activeTimers.delete(pendingTimer);
      pendingTimer = null;
    }
    if (instance !== null) {
      instance.element.remove();
      instance.destroy();
      instance = null;
      document.removeEventListener("mousedown", handleClickOutside);
    }
  }

  function toggle(): void {
    opts.onBeforeOpen?.();
    if (instance !== null) {
      close();
      return;
    }
    instance = opts.create();
    opts.parentEl?.appendChild(instance.element);
    // Defer so this click doesn't immediately close it
    pendingTimer = setTimeout(() => {
      opts.activeTimers.delete(pendingTimer!);
      pendingTimer = null;
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);
    opts.activeTimers.add(pendingTimer);
  }

  return { toggle, close };
}
