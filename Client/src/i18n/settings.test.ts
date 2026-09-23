// B9-20: the settings, account and voice catalogs keep the shipped English and
// type their parameters. These pin the exact copy the seam replaced, so a key
// whose value drifts fails here rather than silently reword the UI.
import { describe, expect, it } from "vitest";
import { accountText } from "./account";
import { settingsText } from "./settings";
import { voiceText } from "./voice";
import { connectText } from "./connect";

describe("B9-20 catalogs", () => {
  it("keeps the settings tabs' labels", () => {
    expect(
      ["account", "appearance", "notifications", "voice", "logs"].map((k) =>
        settingsText(`tabs.${k}` as "tabs.account"),
      ),
    ).toEqual(["Account", "Appearance", "Notifications", "Voice & Audio", "Logs"]);
  });

  it("types a parameter and formats a number parameter in the settings catalog", () => {
    expect(settingsText("appearance.fontSize.value", { size: 16 })).toBe("16px");
    expect(settingsText("logs.entries", { count: 12345 })).toBe("12,345 entries");
  });

  it("carries the account retention and deletion disclosures verbatim", () => {
    expect(accountText("delete.warning")).toContain(
      "Deletion is immediate and permanent: your account, messages and attachments are erased now",
    );
    expect(accountText("devices.signOutEverywhereWarning")).toBe(
      "This signs out every device, including this one. You will need to sign in again here.",
    );
  });

  it("uses a plural branch for the retention window and never concatenates fragments", () => {
    expect(connectText("retention.deleted", { count: 1 })).toBe("deletes messages after 1 day");
    expect(connectText("retention.deleted", { count: 30 })).toBe("deletes messages after 30 days");
    expect(
      connectText("retention.notice", { window: connectText("retention.deleted", { count: 30 }) }),
    ).toBe(
      "By default this server deletes messages after 30 days; attachments are removed with their messages.",
    );
  });

  it("keeps the voice lifecycle and E2EE labels", () => {
    expect(voiceText("status.joining")).toBe("Connecting…");
    expect(voiceText("encryption.unsecuredLabel")).toBe(
      "End-to-end encryption failed — this call may not be protected",
    );
    expect(voiceText("call.isCalling", { name: "Ana" })).toBe("Ana is calling");
  });

  it("inserts user data verbatim rather than treating it as a template", () => {
    expect(voiceText("call.isCalling", { name: "{other}" })).toBe("{other} is calling");
    expect(accountText("profile.usernameInvalid", { max: 32 })).toBe(
      "Username must be 2–32 characters.",
    );
  });
});
