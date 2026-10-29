// The Safety tab's body loads lazily; when that chunk cannot load, the frame
// stays and the failure is logged. This file never loads the body successfully.
import { describe, expect, it, vi } from "vitest";

vi.mock("./SafetyTab", () => {
  throw new Error("chunk unavailable");
});

import { expectConsole } from "../../../tests/helpers/console";
import { captureLogs } from "../../../tests/helpers/log-capture";
import { buildSafetyTab } from "./Notices";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("Safety tab chunk failure", () => {
  it("keeps the frame and logs the failure under the safety component", async () => {
    const logs = captureLogs();
    const pane = buildSafetyTab(new AbortController().signal);
    await flush();
    expect(pane.className).toBe("settings-pane active safety-tab");
    expect(pane.children).toHaveLength(1);
    expect(pane.firstElementChild!.childElementCount).toBe(0);
    const [entry] = logs.find("Safety tab failed to load");
    expect(entry).toMatchObject({ level: "error", component: "safety" });
    expect(entry!.data).toEqual({ error: expect.stringMatching(/^Error: .+/) });
    expectConsole("error", "Safety tab failed to load");
  });
});
