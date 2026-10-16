// The .deb install updates itself through a root helper and a polkit action
// that ship inside the package (LP-14b). The client declines to use the helper
// unless it is root-owned and not writable by others, and polkit shows the
// action's message verbatim, so the three files must agree: the bundle maps
// the helper to the path the policy names and the Rust side runs.

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Asserts src-tauri/tauri.conf.json, which is inside the Client component —
// not a cross-component contract test. See docs/contributing.md#testing.
import tauriConf from "../../src-tauri/tauri.conf.json";

const HELPER_DEST = "/usr/lib/owncord-client/owncord-deb-update";
const POLICY_DEST = "/usr/share/polkit-1/actions/com.owncord.client.update.policy";
const tauriDir = resolve(__dirname, "../../src-tauri");

describe("tauri.conf.json — .deb in-app update", () => {
  const deb = tauriConf.bundle.linux.deb as {
    files?: Record<string, string>;
    recommends?: string[];
    depends?: string[];
  };

  it("ships the helper and the polkit policy from packaging/linux", () => {
    expect(deb.files).toEqual({
      [HELPER_DEST]: "packaging/linux/owncord-deb-update",
      [POLICY_DEST]: "packaging/linux/com.owncord.client.update.policy",
    });
  });

  it("recommends pkexec (or the transitional policykit-1) without depending on it", () => {
    expect(deb.recommends).toContain("pkexec | policykit-1");
    expect(deb.depends).not.toContain("pkexec | policykit-1");
  });

  it("maps files that exist, with the helper executable in the source tree", () => {
    for (const source of Object.values(deb.files ?? {})) {
      expect(statSync(resolve(tauriDir, source)).isFile(), source).toBe(true);
    }
    const mode = statSync(resolve(tauriDir, "packaging/linux/owncord-deb-update")).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it("names the helper in the polkit action, with a password prompt every time", () => {
    const policy = readFileSync(
      resolve(tauriDir, "packaging/linux/com.owncord.client.update.policy"),
      "utf8",
    );
    expect(policy).toContain('<action id="com.owncord.client.update">');
    expect(policy).toContain(
      `<annotate key="org.freedesktop.policykit.exec.path">${HELPER_DEST}</annotate>`,
    );
    for (const key of ["allow_any", "allow_inactive", "allow_active"]) {
      expect(policy).toContain(`<${key}>auth_admin</${key}>`);
    }
    expect(policy).not.toContain("auth_admin_keep");
  });
});
