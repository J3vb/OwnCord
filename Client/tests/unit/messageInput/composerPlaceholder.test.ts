import { describe, expect, it } from "vitest";
import { composerPlaceholder } from "../../../src/features/messaging/composerPlaceholder";

describe("composerPlaceholder", () => {
  it("names a channel with #, a DM with @ and a group by its name", () => {
    expect(composerPlaceholder("channel", "general")).toBe("Message #general");
    expect(composerPlaceholder("dm", "Ana")).toBe("Message @Ana");
    expect(composerPlaceholder("group", "Crew")).toBe("Message Crew");
  });

  it("keeps a 24-character name whole and cuts a longer one to 24 with an ellipsis", () => {
    const exact = "a".repeat(24);
    expect(composerPlaceholder("channel", exact)).toBe(`Message #${exact}`);
    expect(composerPlaceholder("channel", "a-really-long-channel-name-that-goes-on")).toBe(
      "Message #a-really-long-channel-n…",
    );
  });

  it("counts an emoji as one character and never splits it", () => {
    const name = `${"x".repeat(22)}🎉🎉🎉`;
    expect(composerPlaceholder("dm", name)).toBe(`Message @${"x".repeat(22)}🎉…`);
  });
});
