import { describe, expect, it } from "vitest";
import { checkRest } from "../../src/lib/net/wireCheck";
import * as restTable from "../../src/lib/net/restShapes";
import type { RestReplyShapes } from "../../src/lib/net/restReplies";
import { REST_REPLY_FIXTURES, validReply } from "../helpers/restReplyFixtures";

const names = Object.keys(REST_REPLY_FIXTURES) as (keyof RestReplyShapes)[];

describe("the REST reply fixtures", () => {
  it.each(names)("%s is a body its shape accepts", (name) => {
    expect(checkRest(name, REST_REPLY_FIXTURES[name], restTable)).toBeNull();
  });

  it("hands out a copy a test can change", () => {
    const first = validReply("BlockedUsersResponse");
    (first.blocked_user_ids as number[]).push(9);
    expect(validReply("BlockedUsersResponse").blocked_user_ids).toEqual([]);
  });
});
