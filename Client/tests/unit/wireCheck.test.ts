import { describe, expect, it } from "vitest";
import { checkAgainst, checkFrame, checkRest, type WireFault } from "../../src/lib/net/wireCheck";
import { FRAME_SHAPES, type Shape } from "../../src/lib/net/wireShapes";
import * as restTable from "../../src/lib/net/restShapes";
import type { RestReplyShapes } from "../../src/lib/net/restReplies";

// Shape numbers 0 to 4 are the primitives, so a hand-built table starts with them.
const STR = 0;
const NUM = 1;
const BOOL = 2;
const NIL = 3;
const ANY = 4;

function table(...entries: Shape[]): Shape[] {
  return [0, 1, 2, 3, 4, ...entries];
}

function check(shapes: Shape[], ref: number, value: unknown): WireFault | null {
  return checkAgainst(shapes, ref, value);
}

describe("checkAgainst: primitives", () => {
  const t = table();
  it.each([
    [STR, "a", 1, "string"],
    [NUM, 1, "1", "number"],
    [BOOL, false, 0, "boolean"],
    [NIL, null, undefined, "null"],
  ])("shape %i accepts its own type only", (ref, good, bad, expected) => {
    expect(check(t, ref, good)).toBeNull();
    expect(check(t, ref, bad)).toEqual({ path: "", expected });
  });

  it("unknown accepts anything", () => {
    for (const v of [null, 0, "", {}, [], undefined, true]) expect(check(t, ANY, v)).toBeNull();
  });

  it("a shape number outside the table accepts anything", () => {
    expect(check(t, 99, "x")).toBeNull();
  });
});

describe("checkAgainst: arrays", () => {
  const t = table([0, STR]); // 5: array of string
  it("accepts an empty array and an array of the item shape", () => {
    expect(check(t, 5, [])).toBeNull();
    expect(check(t, 5, ["a", "b"])).toBeNull();
  });
  it("rejects a non-array, naming the array itself", () => {
    expect(check(t, 5, "a")).toEqual({ path: "", expected: "array" });
    expect(check(t, 5, { length: 0 })).toEqual({ path: "", expected: "array" });
  });
  it("rejects a bad item with [] in the path and no index", () => {
    expect(check(t, 5, ["a", 2, "c"])).toEqual({ path: "[]", expected: "string" });
  });
});

describe("checkAgainst: maps", () => {
  const t = table([1, NUM]); // 5: map of number
  it("accepts any keys with matching values", () => {
    expect(check(t, 5, {})).toBeNull();
    expect(check(t, 5, { a: 1, b: 2 })).toBeNull();
  });
  it("rejects a non-object and an array", () => {
    expect(check(t, 5, null)).toEqual({ path: "", expected: "object" });
    expect(check(t, 5, [])).toEqual({ path: "", expected: "object" });
  });
  it("rejects a bad value with {} in the path and never the key", () => {
    expect(check(t, 5, { "secret-key": "x" })).toEqual({ path: "{}", expected: "number" });
  });
});

describe("checkAgainst: objects", () => {
  // 5: { id: number, name: string, nick?: string }
  const t = table([2, ["id", "name"], [NUM, STR], ["nick"], [STR]]);
  it("accepts required fields, optional ones present or absent, and extras", () => {
    expect(check(t, 5, { id: 1, name: "a" })).toBeNull();
    expect(check(t, 5, { id: 1, name: "a", nick: "n" })).toBeNull();
    expect(check(t, 5, { id: 1, name: "a", extra: [1] })).toBeNull();
  });
  it("an optional field may be undefined but not the wrong type", () => {
    expect(check(t, 5, { id: 1, name: "a", nick: undefined })).toBeNull();
    expect(check(t, 5, { id: 1, name: "a", nick: 3 })).toEqual({
      path: "nick",
      expected: "string",
    });
  });
  it("a missing required field is named", () => {
    expect(check(t, 5, { name: "a" })).toEqual({ path: "id", expected: "number (missing)" });
  });
  it("a required field that is null or undefined is a fault", () => {
    expect(check(t, 5, { id: null, name: "a" })).toEqual({ path: "id", expected: "number" });
    expect(check(t, 5, { id: undefined, name: "a" })).toEqual({
      path: "id",
      expected: "number (missing)",
    });
  });
  it("rejects values that are not plain objects", () => {
    for (const v of [null, undefined, "s", 3, [], [{ id: 1, name: "a" }]]) {
      expect(check(t, 5, v)).toEqual({ path: "", expected: "object" });
    }
  });
  it("an object with only required fields has no optional list", () => {
    const only = table([2, ["a"], [STR]]);
    expect(check(only, 5, { a: "x", b: 1 })).toBeNull();
    expect(check(only, 5, {})).toEqual({ path: "a", expected: "string (missing)" });
  });
  it("an object with no fields accepts any object", () => {
    const empty = table([2, [], []]);
    expect(check(empty, 5, { anything: 1 })).toBeNull();
    expect(check(empty, 5, 1)).toEqual({ path: "", expected: "object" });
  });
});

describe("checkAgainst: nullable and anyOf", () => {
  it("nullable allows null and the inner shape", () => {
    const t = table([4, STR]); // 5
    expect(check(t, 5, null)).toBeNull();
    expect(check(t, 5, "a")).toBeNull();
    expect(check(t, 5, 1)).toEqual({ path: "", expected: "string" });
  });
  it("nullable descends into an inner object to name the field", () => {
    const t = table([2, ["a"], [NUM]], [4, 5]); // 5 object, 6 nullable object
    expect(check(t, 6, null)).toBeNull();
    expect(check(t, 6, { a: "x" })).toEqual({ path: "a", expected: "number" });
  });
  it("anyOf accepts any member and rejects the rest", () => {
    const t = table([3, STR, NUM]); // 5
    expect(check(t, 5, "a")).toBeNull();
    expect(check(t, 5, 1)).toBeNull();
    expect(check(t, 5, true)).toEqual({ path: "", expected: "string | number" });
  });
  it("anyOf with null as a member accepts null", () => {
    const t = table([3, STR, NUM, NIL]);
    expect(check(t, 5, null)).toBeNull();
  });
  it("anyOf of objects with one object member reports the field inside it", () => {
    const t = table([2, ["a"], [NUM]], [3, 5, STR]); // 6: object | string
    expect(check(t, 6, { a: "x" })).toEqual({ path: "a", expected: "number" });
  });
  it("anyOf of several objects reports the union itself", () => {
    const t = table([2, ["a"], [NUM]], [2, ["b"], [NUM]], [3, 5, 6]);
    expect(check(t, 7, { a: "x" })).toEqual({ path: "", expected: "object" });
  });
});

describe("checkAgainst: nesting", () => {
  // 5: array of item; 6: item { id, tags: string[], owner: {name} | null }; 7: string[]; 8: owner; 9: nullable owner
  const full = table(
    [0, 6],
    [2, ["id", "tags", "owner"], [NUM, 7, 9]],
    [0, STR],
    [2, ["name"], [STR]],
    [4, 8],
  );
  it("accepts a well formed tree", () => {
    expect(check(full, 5, [{ id: 1, tags: ["a"], owner: { name: "n" } }])).toBeNull();
    expect(check(full, 5, [{ id: 1, tags: [], owner: null }])).toBeNull();
  });
  it("names a deep fault by field names only", () => {
    expect(check(full, 5, [{ id: 1, tags: ["a"], owner: { name: 5 } }])).toEqual({
      path: "[].owner.name",
      expected: "string",
    });
    expect(check(full, 5, [{ id: 1, tags: ["a", 2], owner: null }])).toEqual({
      path: "[].tags[]",
      expected: "string",
    });
  });
  it("never puts a value in the fault", () => {
    const fault = check(full, 5, [
      { id: 1, tags: ["a"], owner: { name: "private text" } },
      { id: "x" },
    ]);
    expect(JSON.stringify(fault)).not.toContain("private text");
  });
  it("walks a type that contains itself", () => {
    const tree = table([2, ["name", "kids"], [STR, 6]], [0, 5]); // node { name, kids: node[] }
    expect(check(tree, 5, { name: "a", kids: [{ name: "b", kids: [] }] })).toBeNull();
    expect(
      check(tree, 5, { name: "a", kids: [{ name: "b", kids: [{ name: 1, kids: [] }] }] }),
    ).toEqual({
      path: "kids[].kids[].name",
      expected: "string",
    });
  });
});

describe("checkFrame and checkRest", () => {
  it("passes a frame type with no shape", () => {
    expect(checkFrame("not_a_real_frame", 12)).toBeNull();
  });
  it("does not treat inherited object keys as frame types", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(checkFrame(name, "anything")).toBeNull();
    }
  });
  it("checks a real frame against the generated table", () => {
    expect(Object.keys(FRAME_SHAPES)).toContain("chat_deleted");
    expect(checkFrame("chat_deleted", "nope")).toEqual({ path: "", expected: "object" });
    expect(checkFrame("chat_deleted", {})?.expected).toMatch(/\(missing\)$/);
  });
  it("passes a REST reply name with no shape", () => {
    // No reply is registered yet, so the only name to try is one the types forbid.
    expect(
      checkRest("unregistered" as keyof RestReplyShapes, { any: "thing" }, restTable),
    ).toBeNull();
  });
  it("checks a registered REST reply against the generated table", () => {
    expect(
      checkRest("BlockedUsersResponse", { blocked_user_ids: [1, 2], extra: true }, restTable),
    ).toBeNull();
    expect(checkRest("BlockedUsersResponse", {}, restTable)).toEqual({
      path: "blocked_user_ids",
      expected: "array (missing)",
    });
    expect(checkRest("BlockedUsersResponse", { blocked_user_ids: ["x"] }, restTable)?.path).toBe(
      "blocked_user_ids[]",
    );
  });
  it("never checks the body of a reply nothing reads", () => {
    expect(checkRest("NoBody", { anything: 1 }, restTable)).toBeNull();
    expect(checkRest("NoBody", "text", restTable)).toBeNull();
  });
});

describe("checkFrame: fields the server may leave out", () => {
  const reply = {
    id: 2,
    channel_id: 1,
    user: { id: 1, username: "a", avatar: null },
    content: "hi",
    reply_to: 1,
    attachments: [],
    reactions: [],
    pinned: false,
    timestamp: "2026-11-06T00:00:00Z",
  };

  it("accepts a reply whose parent author has no avatar key", () => {
    const frame = {
      ...reply,
      referenced_message: {
        id: 1,
        user: { id: 3, username: "b" },
        content: "parent",
        deleted: false,
        has_attachments: false,
      },
    };
    expect(checkFrame("chat_message", frame)).toBeNull();
  });
});
