import { describe, it, expect } from "vitest";
import { channelMediaParams } from "@lib/api";

describe("channelMediaParams", () => {
  it("sends only the filters that are set", () => {
    expect(channelMediaParams({ kind: "media" }).toString()).toBe("kind=media");
    expect(
      channelMediaParams({
        kind: "files",
        order: "oldest",
        q: "  beach  ",
        from: 7,
        month: "2026-01",
        tz: "Europe/Brussels",
        cursor: "12_abc",
        limit: 60,
      }).toString(),
    ).toBe(
      "kind=files&order=oldest&q=beach&from=7&month=2026-01&tz=Europe%2FBrussels&cursor=12_abc&limit=60",
    );
  });

  it("drops a blank search, zone and cursor", () => {
    expect(channelMediaParams({ kind: "media", q: "   ", tz: "", cursor: "" }).toString()).toBe(
      "kind=media",
    );
  });
});
