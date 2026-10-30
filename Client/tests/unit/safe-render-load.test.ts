import { describe, expect, it, vi } from "vitest";
import { addLogListener, type LogEntry } from "../../src/lib/logger";
import { expectConsole } from "../helpers/console";

// safe-render names its logger when it loads, so it is loaded inside the test
// body and the component name is read off the line it writes.
describe("safe-render logger name", () => {
  it("writes its log lines under the safe-render component", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const entries: LogEntry[] = [];
    const stop = addLogListener((entry) => entries.push(entry));
    try {
      const { safeMount } = await import("../../src/lib/text/safeRender");
      safeMount(
        {
          mount() {
            throw new Error("nope");
          },
        },
        document.createElement("div"),
      );
    } finally {
      stop();
      vi.restoreAllMocks();
    }
    expectConsole("error", "Component mount failed");
    expect(entries.map((e) => [e.component, e.message])).toEqual([
      ["safe-render", "Component mount failed"],
    ]);
  });
});
