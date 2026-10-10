import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ipcBytes } from "../../../src/platform/desktop/ipcBytes";

const GIF = [71, 73, 70, 56];

describe("ipcBytes", () => {
  test("an ArrayBuffer, a typed-array view and a number array yield the same bytes", () => {
    const fromBuffer = ipcBytes(new Uint8Array(GIF).buffer);
    const fromView = ipcBytes(new Uint8Array(GIF));
    const fromArray = ipcBytes(GIF);
    for (const bytes of [fromBuffer, fromView, fromArray]) {
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect([...bytes]).toEqual(GIF);
    }
  });

  test("a view with a non-zero byteOffset is sliced to its own window", () => {
    const backing = new Uint8Array([9, 9, ...GIF, 9]);
    const view = new Uint8Array(backing.buffer, 2, GIF.length);
    expect([...ipcBytes(view)]).toEqual(GIF);
    expect([...ipcBytes(new DataView(backing.buffer, 2, GIF.length))]).toEqual(GIF);
  });
});

describe("raw-bytes IPC commands", () => {
  const dir = join(__dirname, "../../../src/platform/desktop");
  const rawBytes = /invoke<\s*(ArrayBuffer|Uint8Array)\b/;
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const users = files.filter((f) => rawBytes.test(readFileSync(join(dir, f), "utf8")));

  test("the guard still sees the one raw-bytes consumer", () => {
    expect(users).toEqual(["externalContent.ts"]);
  });

  test("every desktop module that invokes a raw-bytes command imports ipcBytes", () => {
    const offenders = users.filter(
      (f) => !/from\s+"\.\/ipcBytes"/.test(readFileSync(join(dir, f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
