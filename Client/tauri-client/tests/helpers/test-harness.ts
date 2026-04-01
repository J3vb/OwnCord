/**
 * Reusable DOM test harness for OwnCord component unit tests.
 *
 * Eliminates repeated container creation / teardown boilerplate.
 *
 * @example
 * ```ts
 * let harness: TestHarness;
 *
 * beforeEach(() => { harness = createTestHarness(); });
 * afterEach(() => { harness.cleanup(); });
 *
 * it("renders", () => {
 *   harness.mount(createMyComponent());
 *   expect(harness.query(".my-class")).not.toBeNull();
 * });
 * ```
 */

/** Minimal component interface that the harness can mount. */
export interface Mountable {
  mount(el: HTMLElement): void;
  destroy?(): void;
}

export interface TestHarness {
  /** The container div appended to document.body. */
  readonly container: HTMLDivElement;

  /** Calls `component.mount(container)`. */
  mount(component: Mountable): void;

  /** Shorthand for `container.querySelector`. */
  query<E extends Element = Element>(selector: string): E | null;

  /** Shorthand for `container.querySelectorAll`. */
  queryAll<E extends Element = Element>(selector: string): NodeListOf<E>;

  /** Finds an element by selector and dispatches a click event. Throws if not found. */
  click(selector: string): void;

  /** Removes the container from the DOM. Safe to call multiple times. */
  cleanup(): void;
}

/**
 * Creates a fresh DOM container attached to `document.body` and returns
 * helper methods for mounting components, querying, and clicking.
 *
 * Call `cleanup()` in `afterEach` to remove the container.
 */
export function createTestHarness(): TestHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);

  let cleaned = false;

  return {
    get container(): HTMLDivElement {
      return container;
    },

    mount(component: Mountable): void {
      component.mount(container);
    },

    query<E extends Element = Element>(selector: string): E | null {
      return container.querySelector<E>(selector);
    },

    queryAll<E extends Element = Element>(selector: string): NodeListOf<E> {
      return container.querySelectorAll<E>(selector);
    },

    click(selector: string): void {
      const el = container.querySelector(selector) as HTMLElement | null;
      if (el === null) {
        throw new Error(`click("${selector}"): no element found in container`);
      }
      el.click();
    },

    cleanup(): void {
      if (!cleaned) {
        container.remove();
        cleaned = true;
      }
    },
  };
}
