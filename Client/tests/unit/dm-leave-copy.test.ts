import { describe, expect, it } from "vitest";
import { requestsText } from "../../src/i18n/requests";

describe("leave-group confirmation copy", () => {
  it("says leaving is permanent, since nobody can add people back yet", () => {
    const body = requestsText("dm.leaveConfirmBody", { name: "Book Club" });
    expect(body).toBe("You leave Book Club. You won't be able to rejoin this group.");
    expect(body).not.toMatch(/adds you back/i);
  });
});
