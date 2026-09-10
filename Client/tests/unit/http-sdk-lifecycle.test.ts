import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const probe = resolve("tests/helpers/http-sdk-probe.mjs");
type Result = {
  result: {
    status: string | number;
    value?: unknown;
    error?: string;
    body?: null;
    url?: string;
    header?: string;
  };
  calls: { command: string; rid?: number }[];
  bodyExists: boolean;
  unhandled: string[];
  reported: string[];
};

for (const format of ["esm", "cjs"]) {
  describe(`installed HTTP SDK lifecycle (${format})`, () => {
    async function run(scenario: string): Promise<Result> {
      const { stdout } = await exec(process.execPath, [probe, format, scenario], { timeout: 5000 });
      return JSON.parse(stdout) as Result;
    }
    const count = (result: Result, command: string) =>
      result.calls.filter((call) => call.command === command).length;

    it("does no native work for an already-aborted request", async () => {
      const result = await run("pre-aborted");
      expect(result.result.status).toBe("rejected");
      expect(result.calls).toEqual([]);
      expect(result.unhandled).toEqual([]);
    });

    it("cancels delayed headers once and preserves the request rejection", async () => {
      const result = await run("headers-abort");
      expect(result.result).toEqual({ status: "rejected", error: "Request canceled" });
      expect(count(result, "fetch_cancel")).toBe(1);
      expect(count(result, "fetch_cancel_body")).toBe(0);
      expect(result.unhandled).toEqual([]);
    });

    it("disposes a body whose header reply arrives after cancellation", async () => {
      const result = await run("headers-late");
      expect(result.result.status).toBe("rejected");
      expect(result.bodyExists).toBe(false);
      expect(count(result, "fetch_cancel_body")).toBe(1);
      expect(count(result, "fetch_read_body")).toBe(0);
      expect(result.unhandled).toEqual([]);
    });

    it.each(["body-chunk", "body-eof", "body-error", "body-eof-race"])(
      "owns cancellation across %s without repeated disposal or unhandled errors",
      async (scenario) => {
        const result = await run(scenario);
        expect(result.result.status).toBe("rejected");
        expect(count(result, "fetch_cancel")).toBe(0);
        expect(count(result, "fetch_cancel_body")).toBe(1);
        expect(count(result, "fetch_read_body")).toBe(2);
        expect(result.bodyExists).toBe(false);
        expect(result.unhandled).toEqual([]);
        expect(result.reported).toEqual([]);
      },
    );

    it("settles a cancelled user stream even when the outstanding read later fails", async () => {
      const result = await run("stream-cancel");
      expect(result.result.status).toBe("fulfilled");
      expect(count(result, "fetch_cancel_body")).toBe(1);
      expect(count(result, "fetch_cancel")).toBe(0);
      expect(result.bodyExists).toBe(false);
      expect(result.unhandled).toEqual([]);
      expect(result.reported).toEqual([]);
    });

    it.each(["body-acl", "body-transport", "body-wrong-rid"])(
      "keeps unexpected cancellation failure %s observable",
      async (scenario) => {
        const result = await run(scenario);
        expect(result.result.status).toBe("rejected");
        expect(result.reported).toHaveLength(1);
        expect(result.reported[0]).toContain(
          scenario === "body-acl"
            ? "http:allow-fetch-cancel-body not allowed"
            : scenario === "body-transport"
              ? "IPC transport disconnected"
              : "The resource id 999 is invalid.",
        );
        expect(result.unhandled).toEqual([]);
      },
    );

    it.each(["stream-cancel-acl", "stream-cancel-transport"])(
      "returns %s failure to the user-stream caller",
      async (scenario) => {
        const result = await run(scenario);
        expect(result.result.status).toBe("rejected");
        expect(result.result.error).toContain(
          scenario.endsWith("acl") ? "not allowed" : "IPC transport disconnected",
        );
        expect(count(result, "fetch_cancel_body")).toBe(1);
        expect(result.unhandled).toEqual([]);
      },
    );

    it("keeps request-cancellation transport failure observable", async () => {
      const result = await run("headers-cancel-error");
      expect(result.result.status).toBe("rejected");
      expect(result.reported).toHaveLength(1);
      expect(result.reported[0]).toContain("IPC request cancellation failed");
      expect(result.unhandled).toEqual([]);
    });

    it("preserves ordinary read failure and disposes its resource once", async () => {
      const result = await run("read-error");
      expect(result.result).toEqual({ status: "rejected", error: "response body read failed" });
      expect(count(result, "fetch_cancel_body")).toBe(1);
      expect(result.unhandled).toEqual([]);
    });

    it("preserves successful JSON and headers and removes completed abort listeners", async () => {
      const result = await run("normal-eof");
      expect(result.result).toMatchObject({
        status: "fulfilled",
        value: { id: 1 },
        url: "https://fixture.invalid/final",
        header: "preserved",
      });
      expect(count(result, "fetch_cancel")).toBe(0);
      expect(count(result, "fetch_cancel_body")).toBe(0);
      expect(result.unhandled).toEqual([]);
    });

    it("preserves a null-body 204 response and cloned header metadata", async () => {
      const result = await run("no-content");
      expect(result.result).toMatchObject({
        status: 204,
        body: null,
        url: "https://fixture.invalid/final",
        header: "preserved",
      });
      expect(count(result, "fetch_read_body")).toBe(0);
      expect(count(result, "fetch_cancel")).toBe(0);
      expect(result.unhandled).toEqual([]);
    });
  });
}
