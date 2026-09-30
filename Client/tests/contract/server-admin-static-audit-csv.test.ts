// CONTRACT TEST. The artifact under test is owned by Server/admin; see
// server-admin-static-logs.test.ts for why the runner lives here.
//
// Checks the admin panel's audit-log CSV cell quoting and the Copy page
// clipboard rows share the same spreadsheet-formula guard.
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const BRIDGE = `<script>
window.__test = { csvQ: csvQ, state: state, copyAuditLog: copyAuditLog };
</script>`;

interface Panel {
  window: JSDOM["window"];
  csvQ: (v: unknown) => string;
  state: { auditCache: Record<string, unknown>[] };
  copyAuditLog: () => void;
  copied: string[];
}

function loadPanel(): Panel {
  const copied: string[] = [];
  const dom = new JSDOM(adminPanelHtml().replace("</body>", `${BRIDGE}\n</body>`), {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as never;
      Object.defineProperty(window.navigator, "clipboard", {
        value: { writeText: async (v: string) => copied.push(v) },
        configurable: true,
      });
    },
  });
  const test = (dom.window as unknown as { __test: Omit<Panel, "window" | "copied"> }).__test;
  return { window: dom.window, copied, ...test };
}

describe("audit CSV cell quoting", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"])("prefixes %j with a quote", (v) => {
    expect(loadPanel().csvQ(v)).toBe(`"'${v}"`);
  });

  it("leaves ordinary text alone and doubles quotes", () => {
    const { csvQ } = loadPanel();
    expect(csvQ('a "b" =c')).toBe('"a ""b"" =c"');
    expect(csvQ(undefined)).toBe('""');
  });
});

describe("audit Copy page rows", () => {
  it("guards the actor and detail cells a spreadsheet would run as a formula", async () => {
    const panel = loadPanel();
    panel.state.auditCache = [
      {
        created_at: "2026-09-27T00:00:00Z",
        actor_name: "=cmd",
        action: "ban",
        target_type: "user",
        target_id: "7",
        detail: "+SUM(A1)",
      },
    ];
    panel.copyAuditLog();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(panel.copied).toEqual(["2026-09-27T00:00:00Z\t'=cmd\tban\tuser #7\t'+SUM(A1)"]);
  });

  it("leaves ordinary rows untouched", async () => {
    const panel = loadPanel();
    panel.state.auditCache = [
      { created_at: "t", actor_name: "alice", action: "ban", detail: "banned bob" },
    ];
    panel.copyAuditLog();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(panel.copied).toEqual(["t\talice\tban\t\tbanned bob"]);
  });

  it("keeps the server actor's id 0 when it has no name", async () => {
    const panel = loadPanel();
    panel.state.auditCache = [
      { created_at: "t", actor_name: "", actor_id: 0, action: "backup_create", detail: "" },
    ];
    panel.copyAuditLog();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(panel.copied).toEqual(["t\t0\tbackup_create\t\t"]);
    expect(panel.csvQ(0)).toBe('"0"');
  });
});
