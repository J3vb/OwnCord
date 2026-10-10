import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { waitForUpdaterRestart } from "../e2e/support/artifact-app";

// What `tasklist /fo csv /nh /fi "imagename eq owncord-client.exe"` printed on
// the windows-11-arm runner in the v2.2.0-beta.2 dry run, without and with the
// installer's restarted app.
const NONE = "INFO: No tasks are running which match the specified criteria.";
const RUNNING = `"owncord-client.exe","6796","Console","2","28,024 K"`;

// The update installer (passive, /R) starts the updated binary itself when it
// finishes. A smoke launch made before that restart loses the single-instance
// lock to it and exits 0 with no output, so the relaunch must wait for it.
// A fake `tasklist` on PATH answers each call in turn and logs its arguments;
// the helper runs its real exec path against it. Windows has the real
// tasklist and would not run the fake, hence POSIX only.
describe.skipIf(process.platform === "win32")(
  "artifact smoke waits for the update installer's restart",
  () => {
    const platform = process.platform;
    const path = process.env.PATH;
    let dir = "";
    const fakeTasklist = async (...outputs: string[]) => {
      const answers = outputs.map((out, i) => `${i + 1}) echo '${out}' ;;`).join("\n");
      await writeFile(
        join(dir, "tasklist"),
        `#!/bin/sh\necho "$*" >> "${dir}/calls"\ncase $(wc -l < "${dir}/calls") in\n${answers}\n*) echo '${outputs.at(-1)}' ;;\nesac\n`,
      );
      await chmod(join(dir, "tasklist"), 0o755);
    };
    const calls = async () => (await readFile(join(dir, "calls"), "utf8")).trim().split("\n");

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "owncord-tasklist-"));
      process.env.PATH = `${dir}:${path}`;
      Object.defineProperty(process, "platform", { value: "win32" });
    });
    afterEach(async () => {
      Object.defineProperty(process, "platform", { value: platform });
      process.env.PATH = path;
      await rm(dir, { recursive: true, force: true });
    });

    it("returns only once the installer has started the app", async () => {
      await fakeTasklist(NONE, RUNNING);
      await waitForUpdaterRestart();
      expect(await calls()).toEqual([
        "/fo csv /nh /fi imagename eq owncord-client.exe",
        "/fo csv /nh /fi imagename eq owncord-client.exe",
      ]);
    });

    it("fails when the installer never starts the app", async () => {
      await fakeTasklist(NONE);
      await expect(waitForUpdaterRestart(1_500)).rejects.toThrow(/never restarted/);
    });
  },
);
