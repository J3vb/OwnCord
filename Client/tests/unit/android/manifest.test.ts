import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MAIN = join(__dirname, "../../../src-tauri/gen/android/app/src/main");
const manifest = readFileSync(join(MAIN, "AndroidManifest.xml"), "utf8");
const extractionRules = readFileSync(join(MAIN, "res/xml/data_extraction_rules.xml"), "utf8");

const permission = (name: string): RegExp =>
  new RegExp(`<uses-permission\\s+android:name="android\\.permission\\.${name}"`);

describe("the Android manifest", () => {
  it("holds the Bluetooth permission a headset's mic needs in a call", () => {
    expect(manifest).toMatch(permission("BLUETOOTH_CONNECT"));
    // Android 11 and older read the old permission; it is capped there.
    expect(manifest).toMatch(
      /<uses-permission\s+android:name="android\.permission\.BLUETOOTH"\s+android:maxSdkVersion="30"/,
    );
  });

  it("holds the network state permission, so the WebView sees going offline", () => {
    expect(manifest).toMatch(permission("ACCESS_NETWORK_STATE"));
  });

  it("keeps the app's data out of backups and device transfers", () => {
    const application = /<application\b[^>]*>/.exec(manifest)?.[0] ?? "";
    expect(application).toContain('android:allowBackup="false"');
    expect(application).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
    for (const section of ["cloud-backup", "device-transfer"]) {
      const body = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`).exec(extractionRules)?.[1];
      expect(body, section).toBeDefined();
      for (const domain of ["root", "file", "database", "sharedpref"]) {
        expect(body).toContain(`<exclude domain="${domain}" path="." />`);
        expect(body).toContain(`<exclude domain="device_${domain}" path="." />`);
      }
      expect(body).toContain('<exclude domain="external" path="." />');
    }
  });

  it("offers the app in the share sheet for one or several items of any type", () => {
    const activity = /<activity\b[\s\S]*?<\/activity>/.exec(manifest)?.[0] ?? "";
    for (const action of ["SEND", "SEND_MULTIPLE"]) {
      const filter = new RegExp(
        `<intent-filter>\\s*<action android:name="android\\.intent\\.action\\.${action}" />([\\s\\S]*?)</intent-filter>`,
      ).exec(activity)?.[1];
      expect(filter, action).toBeDefined();
      expect(filter).toContain('<category android:name="android.intent.category.DEFAULT" />');
      expect(filter).toContain('<data android:mimeType="*/*" />');
    }
  });
});
