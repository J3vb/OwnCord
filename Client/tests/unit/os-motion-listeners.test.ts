import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncOsMotionListener } from "../../src/lib/ui/osMotion";

/** A media query list that is a real event target, so a listener registered
 *  with an AbortSignal really stops hearing changes once it aborts. */
function fakeQuery(matches: boolean): MediaQueryList {
  return Object.assign(new EventTarget(), { matches, media: "" }) as unknown as MediaQueryList;
}

function osChange(query: MediaQueryList, matches: boolean): void {
  query.dispatchEvent(Object.assign(new Event("change"), { matches }));
}

const reduced = (): boolean => document.documentElement.classList.contains("reduced-motion");

describe("syncOsMotionListener listener lifetime", () => {
  let queries: MediaQueryList[];

  beforeEach(() => {
    queries = [];
    localStorage.clear();
    document.documentElement.classList.remove("reduced-motion");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => {
        const query = fakeQuery(false);
        queries.push(query);
        return query;
      }),
    );
  });

  afterEach(() => {
    syncOsMotionListener(false);
    document.documentElement.classList.remove("reduced-motion");
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("stops hearing the previous query once the sync is registered again", () => {
    syncOsMotionListener(true);
    syncOsMotionListener(true);
    expect(queries).toHaveLength(2);

    osChange(queries[0]!, true);
    expect(reduced()).toBe(false);

    osChange(queries[1]!, true);
    expect(reduced()).toBe(true);
  });

  it("stops hearing the OS once the sync is turned off", () => {
    syncOsMotionListener(true);
    syncOsMotionListener(false);

    osChange(queries[0]!, true);
    expect(reduced()).toBe(false);
  });

  it("keeps the manual preference when the OS stops asking for reduced motion", () => {
    localStorage.setItem("owncord:settings:reducedMotion", "true");
    syncOsMotionListener(true);
    expect(reduced()).toBe(true);

    osChange(queries[0]!, false);
    expect(reduced()).toBe(true);
  });
});
