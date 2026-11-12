// CallRing.kt posts the incoming call's notification. None of it runs outside
// Android, so the lines its ringtone depends on are pinned as source: tidying
// one away would leave a ring that is shown again without its ringtone (the
// file's header says why).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(
    __dirname,
    "../../../src-tauri/gen/android/app/src/main/java/com/owncord/client/CallRing.kt",
  ),
  "utf8",
);
/** The code alone: a comment may name what the code must not do. */
const code = source.replace(/^\s*\/\/.*$/gm, "");
const post = /fun post\([\s\S]*?\n {2}\}/.exec(code)?.[0] ?? "";

describe("the incoming call's notification", () => {
  it("is never marked to alert once, so a ring that is shown again rings on", () => {
    expect(code).not.toMatch(/setOnlyAlertOnce|FLAG_ONLY_ALERT_ONCE/);
  });

  it("rings until it is taken down, unless its sound is off", () => {
    expect(post).toContain(
      "if (!args.quiet) notification.flags = notification.flags or Notification.FLAG_INSISTENT",
    );
  });

  it("comes down before it goes up again below Android 13, where its own update would stop the ringtone", () => {
    const down = post.indexOf(
      "if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) manager(context).cancel(NOTIFICATION_ID)",
    );
    const up = post.indexOf("manager(context).notify(NOTIFICATION_ID, notification)");
    expect(down).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(down);
  });
});
