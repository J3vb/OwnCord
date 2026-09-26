// CONTRACT TEST. The artifact under test is owned by Server/admin; see
// server-admin-static-logs.test.ts for why the runner lives here.
//
// Checks the admin panel's audit-log CSV cell quoting.
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const BRIDGE = "<script>window.__csvQ = csvQ;</script>";

function loadCsvQ(): (v: unknown) => string {
  const dom = new JSDOM(adminPanelHtml().replace("</body>", `${BRIDGE}\n</body>`), {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    beforeParse(window) {
      window.fetch = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as never;
    },
  });
  return (dom.window as unknown as { __csvQ: (v: unknown) => string }).__csvQ;
}

describe("audit CSV cell quoting", () => {
  const csvQ = loadCsvQ();

  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"])("prefixes %j with a quote", (v) => {
    expect(csvQ(v)).toBe(`"'${v}"`);
  });

  it("leaves ordinary text alone and doubles quotes", () => {
    expect(csvQ('a "b" =c')).toBe('"a ""b"" =c"');
    expect(csvQ(undefined)).toBe('""');
  });
});
