// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// The "Import from Discord" card on the Channels page, driven against the
// real admin scripts in jsdom: progress polling, the result line, the
// retention warning and that server text never reaches markup.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const BRIDGE = `<script>
window.__test = {
  initDiscordImport: initDiscordImport,
  pollDiscordImport: pollDiscordImport,
  cancelDiscordImport: cancelDiscordImport,
  startDiscordImport: startDiscordImport,
  handleSessionExpired: handleSessionExpired,
  importUI: importUI,
  state: state
};
</script>`;
const source = adminPanelHtml();
if (!source.includes("</body>")) {
  throw new Error("expected Server/admin/static/index.html to contain </body>");
}
const ADMIN_HTML = source.replace("</body>", `${BRIDGE}\n</body>`);

interface FetchCall {
  method: string;
  path: string;
}
interface Job {
  id: number;
  status: string;
  source_name: string;
  imported: number;
  skipped: number;
  skipped_attachments: number;
  error: string | null;
}
interface Bridge {
  initDiscordImport: () => Promise<void>;
  pollDiscordImport: () => Promise<void>;
  cancelDiscordImport: () => Promise<void>;
  startDiscordImport: () => Promise<void>;
  handleSessionExpired: () => void;
  importUI: { pollTimer: unknown };
  state: { categoryList: unknown[]; token: string };
}

const job = (over: Partial<Job> = {}): Job => ({
  id: 7,
  status: "running",
  source_name: "general.zip",
  imported: 500,
  skipped: 0,
  skipped_attachments: 0,
  error: null,
  ...over,
});

async function boot(
  calls: FetchCall[],
  respond: (path: string, method: string) => unknown,
): Promise<{ dom: JSDOM; bridge: Bridge; doc: Document }> {
  const dom = new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (async (input: string, opts: Record<string, unknown> = {}) => {
        const method = String((opts.method as string) || "GET").toUpperCase();
        const path = String(input).replace(/^\/admin\/api/, "");
        calls.push({ method, path });
        const json = path === "/setup/status" ? { needs_setup: false } : respond(path, method);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => json ?? {},
          text: async () => JSON.stringify(json ?? {}),
        } as Response;
      }) as typeof fetch;
    },
  });
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  calls.length = 0;
  const bridge = (dom.window as unknown as { __test: Bridge }).__test;
  expect(bridge).toBeTruthy();
  const doc = dom.window.document;
  const content = doc.getElementById("content");
  if (!content) throw new Error("expected #content");
  content.innerHTML = '<div class="section-card" id="discordImportCard"></div>';
  return { dom, bridge, doc };
}

const latest = (j: Job | null, extra: Record<string, unknown> = {}) => ({
  job: j,
  retention_days: 0,
  max_upload_bytes: 500 << 20,
  ...extra,
});

describe("Server/admin/static — Import from Discord card", () => {
  let dom: JSDOM | undefined;
  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("shows the form with the help text and a category choice when nothing is running", async () => {
    const calls: FetchCall[] = [];
    const b = await boot(calls, () => latest(null));
    dom = b.dom;
    b.bridge.state.categoryList = [{ id: 3, name: "Archive <b>" }];
    await b.bridge.initDiscordImport();
    const card = b.doc.getElementById("discordImportCard") as HTMLElement;
    expect(card.textContent).toContain("Download media");
    expect(card.textContent).toContain("_Files");
    const file = b.doc.getElementById("discordImportFile") as HTMLInputElement;
    expect(file.accept).toBe(".json,.zip");
    const sel = b.doc.getElementById("discordImportCategory") as HTMLSelectElement;
    expect([...sel.options].map((o) => `${o.value}:${o.textContent}`)).toEqual([
      "0:No category",
      "3:Archive <b>",
    ]);
    expect(sel.querySelector("b")).toBeNull();
    expect(b.doc.getElementById("discordImportGo")?.getAttribute("data-action")).toBe(
      "startDiscordImport",
    );
    expect(card.querySelector("progress")).toBeNull();
    expect(card.textContent).not.toContain("retention");
  });

  it("resumes a running import: progress bar, count so far and a cancel button", async () => {
    const calls: FetchCall[] = [];
    const b = await boot(calls, () => latest(job()));
    dom = b.dom;
    await b.bridge.initDiscordImport();
    const card = b.doc.getElementById("discordImportCard") as HTMLElement;
    expect(card.querySelector("progress")).not.toBeNull();
    expect(b.doc.getElementById("discordImportProgress")?.textContent).toBe(
      "Importing general.zip: 500 messages so far…",
    );
    expect(card.querySelector('[data-action="cancelDiscordImport"]')).not.toBeNull();
    expect(b.doc.getElementById("discordImportFile")).toBeNull();
    expect(b.bridge.importUI.pollTimer).not.toBeNull();
  });

  it("polls the job by id and ends on the result line", async () => {
    const calls: FetchCall[] = [];
    let current = job();
    const b = await boot(calls, (path) =>
      path === "/discord-imports/latest" ? latest(current) : current,
    );
    dom = b.dom;
    await b.bridge.initDiscordImport();

    current = job({ imported: 1500 });
    await b.bridge.pollDiscordImport();
    expect(calls.at(-1)).toEqual({ method: "GET", path: "/discord-imports/7" });
    expect(b.doc.getElementById("discordImportProgress")?.textContent).toContain(
      "1500 messages so far",
    );

    current = job({ status: "done", imported: 4, skipped: 3, skipped_attachments: 1 });
    await b.bridge.pollDiscordImport();
    const result = b.doc.getElementById("discordImportResult");
    expect(result?.textContent).toBe(
      "Last import (general.zip): Imported 4 messages. Skipped 3 messages it could not take. Skipped 1 attachment (not in the export, a blocked type or too large).",
    );
    expect(b.doc.querySelector("#discordImportCard progress")).toBeNull();
    expect(b.doc.getElementById("discordImportFile")).not.toBeNull();
  });

  it("never turns server text into markup", async () => {
    const hostile = '<img src=x onerror="window.pwned=1">';
    const calls: FetchCall[] = [];
    let current = job({ source_name: hostile });
    const b = await boot(calls, (path) =>
      path === "/discord-imports/latest" ? latest(current) : current,
    );
    dom = b.dom;
    await b.bridge.initDiscordImport();
    const card = b.doc.getElementById("discordImportCard") as HTMLElement;
    expect(card.textContent).toContain(hostile);
    expect(card.querySelector("img")).toBeNull();

    current = job({
      status: "failed",
      source_name: hostile,
      error: "<script>window.pwned=1</script>",
    });
    await b.bridge.pollDiscordImport();
    expect(b.doc.getElementById("discordImportResult")?.textContent).toContain(
      "<script>window.pwned=1</script>",
    );
    expect(card.querySelector("img, script")).toBeNull();
    expect((dom.window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it("warns that retention will delete old imported messages, only while retention is on", async () => {
    const calls: FetchCall[] = [];
    const b = await boot(calls, () => latest(null, { retention_days: 30 }));
    dom = b.dom;
    await b.bridge.initDiscordImport();
    const note = b.doc.querySelector("#discordImportCard .callout-warning");
    expect(note?.textContent).toContain("older than 30 days are deleted automatically");
  });

  it("cancel posts to the job's cancel route and keeps polling for the end", async () => {
    const calls: FetchCall[] = [];
    const b = await boot(calls, (path) =>
      path === "/discord-imports/latest" ? latest(job()) : { id: 7, status: "cancelling" },
    );
    dom = b.dom;
    await b.bridge.initDiscordImport();
    await b.bridge.cancelDiscordImport();
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/discord-imports/7/cancel" });
    expect(b.doc.getElementById("discordImportProgress")?.textContent).toBe("Cancelling…");
    expect(b.bridge.importUI.pollTimer).not.toBeNull();
  });

  it("explains a non-JSON failure from a proxy by its status", async () => {
    const calls: FetchCall[] = [];
    const b = await boot(calls, () => latest(null));
    dom = b.dom;
    await b.bridge.initDiscordImport();
    const win = b.dom.window as unknown as { fetch: unknown };
    win.fetch = async () =>
      ({
        ok: false,
        status: 413,
        headers: new Headers({ "content-type": "text/html" }),
        json: async () => {
          throw new Error("not json");
        },
      }) as unknown as Response;
    const input = b.doc.getElementById("discordImportFile") as HTMLInputElement;
    Object.defineProperty(input, "files", {
      value: [new b.dom.window.File(["{}"], "export.json")],
    });
    await b.bridge.startDiscordImport();
    expect(b.doc.querySelector('#discordImportCard [role="alert"]')?.textContent).toContain(
      "larger than this server or a reverse proxy",
    );
  });

  it("frees the form after a 401 ends the session mid-upload and the admin signs in again", async () => {
    const calls: FetchCall[] = [];
    const b = await boot(calls, () => latest(null));
    dom = b.dom;
    b.bridge.state.token = "first";
    await b.bridge.initDiscordImport();
    (b.dom.window as unknown as { fetch: unknown }).fetch = async () =>
      ({
        ok: false,
        status: 401,
        headers: new Headers(),
        json: async () => ({}),
      }) as unknown as Response;
    const input = b.doc.getElementById("discordImportFile") as HTMLInputElement;
    Object.defineProperty(input, "files", {
      value: [new b.dom.window.File(["{}"], "export.json")],
    });
    await b.bridge.startDiscordImport();
    expect(b.bridge.state.token).toBe("");

    b.doc.getElementById("content")!.innerHTML =
      '<div class="section-card" id="discordImportCard"></div>';
    b.bridge.state.token = "second";
    (b.dom.window as unknown as { fetch: unknown }).fetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => latest(null),
      }) as unknown as Response;
    await b.bridge.initDiscordImport();
    const go = b.doc.getElementById("discordImportGo") as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    expect(go.textContent).toBe("Import");
    expect((b.doc.getElementById("discordImportFile") as HTMLInputElement).disabled).toBe(false);
  });
});
