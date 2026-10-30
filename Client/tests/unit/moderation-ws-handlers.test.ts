// Moderation Center frames: each queue change bumps only its own view's signal.
import { beforeEach, describe, expect, it } from "vitest";
import { handleModQueue } from "../../src/features/moderation/wsHandlers";
import { modAppealStore, modQueueStore } from "../../src/features/moderation/store";
import type { Payload } from "../../src/features/connection/dispatchContext";

const frame = (fields: Record<string, unknown>): Payload<"mod_queue"> =>
  fields as unknown as Payload<"mod_queue">;

describe("mod_queue frames", () => {
  beforeEach(() => {
    modQueueStore.setState(() => 0);
    modAppealStore.setState(() => 0);
  });

  it("a report change refreshes the report queue only", () => {
    handleModQueue(frame({ report_id: "r1" }));
    expect(modQueueStore.getState()).toBe(1);
    expect(modAppealStore.getState()).toBe(0);
  });

  it("an appeal change refreshes the appeal queue only", () => {
    handleModQueue(frame({ appeal_id: "a1" }));
    expect(modQueueStore.getState()).toBe(0);
    expect(modAppealStore.getState()).toBe(1);
  });

  it("a frame carrying both refreshes both", () => {
    handleModQueue(frame({ report_id: "r1", appeal_id: "a1" }));
    expect(modQueueStore.getState()).toBe(1);
    expect(modAppealStore.getState()).toBe(1);
  });

  it("a frame carrying neither refreshes nothing", () => {
    handleModQueue(frame({}));
    handleModQueue(frame({ report_id: 5, appeal_id: null }));
    expect(modQueueStore.getState()).toBe(0);
    expect(modAppealStore.getState()).toBe(0);
  });
});
