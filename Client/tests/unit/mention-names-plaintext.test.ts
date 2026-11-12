// Plain-text views (OS notifications, reply previews, the DM list, search)
// show a stored `<@id>` / `<@&id>` token as the name it stands for, never as
// the raw token.
import { beforeEach, describe, expect, it } from "vitest";
import { markdownToPlainText } from "../../src/lib/text/markdown";
import { idMentionsToNames } from "../../src/lib/text/mentionNames";
import { membersStore } from "../../src/stores/members.store";
import { channelsStore } from "../../src/stores/channels.store";
import { resetChannelsState } from "../helpers/storeSeeds";
// Registers the name lookups, as loading the signed-in page does.
import "../../src/features/messaging/content/contentMentions";

function seed(): void {
  membersStore.setState((p) => ({
    ...p,
    members: new Map([
      [7, { id: 7, username: "alice", displayName: "Alice A.", status: "online" } as never],
      [8, { id: 8, username: "bob", status: "online" } as never],
    ]),
  }));
  channelsStore.setState((p) => ({
    ...p,
    roles: [{ id: 5, name: "Night Owls", color: null, permissions: 0, position: 1 } as never],
  }));
}

describe("idMentionsToNames", () => {
  beforeEach(() => {
    resetChannelsState();
    membersStore.setState((p) => ({ ...p, members: new Map() }));
    seed();
  });

  it("names users by their shown name and roles by their name", () => {
    expect(idMentionsToNames("hi <@7> and <@8>, ping <@&5>")).toBe(
      "hi @Alice A. and @bob, ping @Night Owls",
    );
  });

  it("leaves a token it cannot name as it is", () => {
    expect(idMentionsToNames("<@99> <@&42>")).toBe("<@99> <@&42>");
  });

  it("leaves text without tokens untouched", () => {
    const text = "a <b> c @alice";
    expect(idMentionsToNames(text)).toBe(text);
  });
});

describe("markdownToPlainText with id mentions", () => {
  beforeEach(() => {
    resetChannelsState();
    seed();
  });

  it("names tokens in prose, also inside bold text", () => {
    expect(markdownToPlainText("**<@7>** look, <@&5>!", "Spoiler")).toBe(
      "@Alice A. look, @Night Owls!",
    );
  });

  it("keeps a token in inline code as typed", () => {
    expect(markdownToPlainText("`<@7>` is the syntax", "Spoiler")).toBe("<@7> is the syntax");
  });
});
