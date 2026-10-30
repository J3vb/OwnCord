/**
 * The desktop build keeps the stored credential through an `auth_error`: the
 * portal's delete (6.13e) sits behind `__OWNCORD_WEB__`, and this guards the
 * branch against leaking into the desktop path.
 */
import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ deleteCredential: vi.fn(async () => true) }));
vi.mock("../../src/lib/net/credentials", () => ({ deleteCredential: hoisted.deleteCredential }));
vi.mock("../../src/lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { handleAuthError } from "../../src/features/connection/wsHandlers";

describe("handleAuthError on desktop", () => {
  it("does not delete the stored credential", async () => {
    expect(__OWNCORD_WEB__).toBe(false);
    const api = { getConfig: () => ({ host: "chat.example", token: "T1" }) };
    handleAuthError(api as never, { message: "invalid token" });
    handleAuthError(api as never, {
      message: "update",
      code: "protocol_epoch_unsupported",
      server_epoch: 9,
    });
    await Promise.resolve();
    expect(hoisted.deleteCredential).not.toHaveBeenCalled();
  });
});
