// B9-19: the messaging catalogs keep the shipped English and type their
// parameters. These pin the exact copy the seam replaced, so a key whose value
// drifts fails here rather than silently reword the UI.
import { describe, expect, it } from "vitest";
import { messageStatusText } from "./messageStatus";
import { messagingText } from "./messaging";
import { requestsText } from "./requests";

describe("B9-19 catalogs", () => {
  it("keeps the message list's English states", () => {
    expect(messagingText("welcome.channel", { channel: "general" })).toBe("Welcome to #general!");
    expect(messagingText("welcome.channelIntro", { channel: "general" })).toBe(
      "This is the start of the #general channel.",
    );
    expect(messagingText("welcome.dmIntro", { name: "Ana" })).toBe(
      "This is the beginning of your direct message history with Ana.",
    );
    expect(messagingText("loadFailed")).toBe("Couldn't load messages");
    expect(messagingText("jumpToPresent")).toBe("Jump to Present ↓");
  });

  it("formats the grouped date stamps through parameters", () => {
    expect(messageStatusText("date.today", { time: "2:34 PM" })).toBe("Today at 2:34 PM");
    expect(messageStatusText("date.yesterday", { time: "2:34 PM" })).toBe("Yesterday at 2:34 PM");
  });

  it("uses a plural branch for the reactor overflow and never concatenates fragments", () => {
    expect(messageStatusText("reaction.others", { count: 1 })).toBe("and 1 other");
    expect(messageStatusText("reaction.others", { count: 2 })).toBe("and 2 others");
    expect(messageStatusText("reaction.reactedWith", { emoji: "🔥" })).toBe("reacted with 🔥");
  });

  it("keeps the composer errors and their parameterised values", () => {
    // The max stays ungrouped, exactly as the literal was: "4000", not "4,000".
    expect(messagingText("error.tooLong", { max: "4000" })).toBe(
      "Messages are limited to 4000 characters",
    );
    expect(messagingText("error.fileTooLarge", { filename: "clip.mp4" })).toBe(
      "File too large: clip.mp4 exceeds 100 MB limit",
    );
    expect(messagingText("composer.slowMode", { seconds: "5" })).toBe("Slow mode — 5s");
  });

  it("keeps the DM sidebar's plural badge titles", () => {
    expect(requestsText("mention.count", { count: 1 })).toBe("1 mention");
    expect(requestsText("mention.count", { count: 4 })).toBe("4 mentions");
    expect(requestsText("unread.count", { count: 1 })).toBe("1 unread message");
    expect(requestsText("unread.count", { count: 12 })).toBe("12 unread messages");
    expect(requestsText("members.count", { count: 3 })).toBe("3 members");
    expect(requestsText("dm.groupSubtitle", { count: 3, names: "Ana, Bo" })).toBe(
      "3 members: You, Ana, Bo",
    );
  });

  it("inserts user data verbatim rather than treating it as a template", () => {
    expect(messagingText("welcome.dmIntro", { name: "{channel}" })).toBe(
      "This is the beginning of your direct message history with {channel}.",
    );
    expect(requestsText("dm.backTo", { server: "{name}" })).toBe("Back to {name}");
  });

  it("keeps the picker and profile copy", () => {
    expect(requestsText("picker.groupHint", { max: "9" })).toBe(
      "Select one member for a DM, or up to 9 for a group",
    );
    expect(requestsText("picker.createGroup", { count: 4 })).toBe("Create Group DM (4)");
    expect(requestsText("profile.about")).toBe("ABOUT ME");
  });
});
