/** The moderation centre's change counters: each frame moves its own counter up by one. */
import { afterEach, describe, expect, it } from "vitest";
import {
  modAppealStore,
  modQueueStore,
  noteAppealChange,
  noteQueueChange,
} from "../../src/features/moderation/store";

afterEach(() => {
  modQueueStore.setState(() => 0);
  modAppealStore.setState(() => 0);
});

describe("moderation change counters", () => {
  it("counts report-queue frames upward without touching the appeal counter", () => {
    noteQueueChange();
    expect(modQueueStore.getState()).toBe(1);
    noteQueueChange();
    expect(modQueueStore.getState()).toBe(2);
    expect(modAppealStore.getState()).toBe(0);
  });

  it("counts appeal-queue frames upward without touching the report counter", () => {
    noteAppealChange();
    noteAppealChange();
    noteAppealChange();
    expect(modAppealStore.getState()).toBe(3);
    expect(modQueueStore.getState()).toBe(0);
  });
});
