import { describe, it, expect } from "vitest";
import { serverErrorCopy } from "../../src/lib/apiShared";
import { connectText } from "../../src/i18n/connect";
import { RestErrorCode, WsErrorCode } from "@lib/protocolTypes";
import { AUTH_SLICE } from "../helpers/authSlice";

const NOT_IN_SLICE = [
  "",
  "unknown",
  "Failed to logout",
  "failed to logout ",
  " failed to logout",
  "FAILED TO LOGOUT",
  "failed to",
  "constructor",
  "__proto__",
  "toString",
];

describe("auth slice error copy", () => {
  it.each(AUTH_SLICE)("internal error %j reads as %s", (message, key) => {
    expect(serverErrorCopy(RestErrorCode.INTERNAL_ERROR, message)).toBe(connectText(key));
    expect(serverErrorCopy(WsErrorCode.INTERNAL, message)).toBe(connectText(key));
    expect(serverErrorCopy(RestErrorCode.RATE_LIMITED, message)).toBe(connectText(key));
  });

  it.each(NOT_IN_SLICE)("unmapped message %j has no slice copy", (message) => {
    expect(serverErrorCopy(RestErrorCode.INTERNAL_ERROR, message)).toBeNull();
    expect(serverErrorCopy(WsErrorCode.INTERNAL, message)).toBeNull();
    expect(serverErrorCopy(RestErrorCode.RATE_LIMITED, message)).toBe(
      connectText("error.rateLimited"),
    );
  });

  it("ignores a slice sentence under a code that does not consult the slice", () => {
    expect(serverErrorCopy(RestErrorCode.CONFLICT, "failed to logout")).toBeNull();
    expect(serverErrorCopy(RestErrorCode.UNAUTHORIZED, "failed to logout")).toBeNull();
    expect(serverErrorCopy("SOMETHING_ELSE", "failed to logout")).toBeNull();
  });
});
