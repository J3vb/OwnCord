// main.ts runs its app-lifetime steps from two lists in app/startup.ts.
import { describe, expect, it, vi } from "vitest";
import {
  afterCoreSteps,
  beforeRenderSteps,
  runStartupSteps,
  type StartupStep,
} from "../../src/app/startup";
import type { ApiClient } from "../../src/lib/api";

describe("startup steps", () => {
  it("names each step once", () => {
    const names = [...beforeRenderSteps, ...afterCoreSteps({} as ApiClient)].map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("runs the steps in list order", () => {
    const order: string[] = [];
    const steps: StartupStep[] = ["a", "b", "c"].map((name) => ({
      name,
      run: () => order.push(name),
    }));
    runStartupSteps(steps, { log: { warn: vi.fn() } as never });
    expect(order).toEqual(["a", "b", "c"]);
  });
});
