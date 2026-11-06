import { describe, expect, it, vi } from "vitest";
import { readReply } from "../../src/lib/apiReply";
import { ApiClientError, REPLY_SHAPE_CODE } from "../../src/lib/apiShared";
import { expectConsole } from "../helpers/console";
import { validReply } from "../helpers/restReplyFixtures";

const AT = { method: "GET", path: "/blocks?limit=5", status: 200 } as const;
const BODY = validReply("BlockedUsersResponse");

let attempts = 0;
vi.mock("../../src/lib/net/restShapes", async (importActual) => {
  attempts += 1;
  if (attempts === 1) throw new Error("Failed to fetch dynamically imported module");
  return importActual();
});

describe("loading the REST shape table", () => {
  it("fails like an unreadable reply when the chunk will not load, then retries and loads it once", async () => {
    const first = readReply("BlockedUsersResponse", BODY, AT);
    await expect(first).rejects.toBeInstanceOf(ApiClientError);
    await expect(first).rejects.toMatchObject({ status: 200, code: REPLY_SHAPE_CODE });
    expectConsole("warn", /Reply shape table failed to load/);

    await expect(readReply("BlockedUsersResponse", BODY, AT)).resolves.toEqual(BODY);
    await readReply("BlockedUsersResponse", BODY, AT);
    expect(attempts).toBe(2);
  });
});
