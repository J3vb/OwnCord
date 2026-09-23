// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// RI-06: the channel-permissions modal's "Explain access" and "Preview matrix
// change" controls. The panel must ask the server for every decision and
// render what it answers — it holds no permission engine of its own — and a
// preview must never write an override.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

const ADMIN_HTML_PATH = path.resolve(__dirname, "../../../Server/admin/static/index.html");
const ADMIN_HTML_SOURCE = readFileSync(ADMIN_HTML_PATH, "utf8");

// Classic-script bindings never land on `window`; bridge the ones driven here.
const BRIDGE = `<script>
window.__test = {
  state: state,
  renderChannelPermsModal: renderChannelPermsModal,
  renderPermMatrix: renderPermMatrix,
  explainAccess: explainAccess,
  previewPermChange: previewPermChange
};
</script>`;
if (!ADMIN_HTML_SOURCE.includes("</body>")) {
  throw new Error("expected Server/admin/static/index.html to contain </body>");
}
const ADMIN_HTML = ADMIN_HTML_SOURCE.replace("</body>", `${BRIDGE}\n</body>`);

interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

/* eslint-disable  @typescript-eslint/no-explicit-any */
interface Bridge {
  state: any;
  renderChannelPermsModal: () => void;
  renderPermMatrix: () => void;
  explainAccess: () => Promise<void>;
  previewPermChange: () => Promise<void>;
}

async function openModal(
  calls: FetchCall[],
  respond: (p: string) => unknown,
): Promise<{ dom: JSDOM; bridge: Bridge }> {
  const dom = new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (async (input: string, opts: Record<string, unknown> = {}) => {
        const method = String((opts.method as string) || "GET").toUpperCase();
        const p = String(input).replace(/^\/admin\/api/, "");
        const body = typeof opts.body === "string" ? JSON.parse(opts.body) : undefined;
        calls.push({ method, path: p, body });
        const json = p === "/setup/status" ? { needs_setup: false } : respond(p);
        return { ok: true, status: 200, json: async () => json ?? {} } as Response;
      }) as typeof fetch;
    },
  });
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  calls.length = 0;
  const bridge = (dom.window as unknown as { __test: Bridge }).__test;
  bridge.state.permChannel = {
    id: 42,
    name: "general",
    roles: [{ role_id: 5, role_name: "Member", permissions: 3, allow: 0, deny: 0 }],
    users: [],
    allUsers: [{ id: 7, username: "alice" }],
  };
  bridge.renderChannelPermsModal();
  return { dom, bridge };
}

describe("Server/admin/static/index.html — access explanation and preview (RI-06)", () => {
  let dom: JSDOM | undefined;
  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("asks the server to explain a member's access and renders its verdict and rules", async () => {
    const calls: FetchCall[] = [];
    const opened = await openModal(calls, () => ({
      user_id: 7,
      username: "alice",
      role_name: "Member",
      restrictions: { timed_out: true, registration_status: "active" },
      decisions: [
        {
          action: "send_message",
          allowed: false,
          reason: "user is timed out",
          bits: [
            {
              bit: "SEND_MESSAGES",
              base: true,
              role_override: "deny",
              user_override: "allow",
              effective: true,
            },
          ],
        },
      ],
    }));
    dom = opened.dom;
    const doc = dom.window.document;
    (doc.getElementById("explainUser") as HTMLSelectElement).value = "7";
    (doc.getElementById("explainAction") as HTMLSelectElement).value = "send_message";

    await opened.bridge.explainAccess();

    expect(calls).toEqual([
      {
        method: "GET",
        path: "/channels/42/access/explain?user_id=7&action=send_message",
        body: undefined,
      },
    ]);
    const out = doc.getElementById("permExplain")!.textContent!;
    // The panel shows the server's verdict even though the bit trace alone
    // would read as allowed: the timeout is a non-role restriction.
    expect(out).toContain("Denied");
    expect(out).toContain("user is timed out");
    expect(out).toContain("timed out");
    expect(out).toContain("SEND_MESSAGES");
    expect(out).toMatch(/deny.*allow/);
  });

  it("previews the matrix's proposed role override without writing it", async () => {
    const calls: FetchCall[] = [];
    const opened = await openModal(calls, () => ({
      channel_id: 42,
      evaluated: 3,
      members: [
        {
          user_id: 7,
          username: "alice",
          changes: [
            {
              action: "view_channel",
              before: true,
              after: false,
              after_reason: "permission denied: missing READ_MESSAGES",
            },
          ],
        },
      ],
    }));
    dom = opened.dom;
    const doc = dom.window.document;
    (doc.getElementById("permTarget") as HTMLSelectElement).value = "r:5";
    opened.bridge.renderPermMatrix();
    (doc.querySelector('input[name="ovr2"][value="deny"]') as HTMLInputElement).checked = true;

    await opened.bridge.previewPermChange();

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/channels/42/access/preview",
        body: { allow: 0, deny: 2, role_id: 5 },
      },
    ]);
    const out = doc.getElementById("permPreview")!.textContent!;
    expect(out).toContain("1 of 3 member(s) would change");
    expect(out).toContain("alice");
    expect(out).toContain("View channel");
    expect(out).toContain("missing READ_MESSAGES");

    // Changing the target discards a preview that no longer describes it.
    (doc.getElementById("permTarget") as HTMLSelectElement).value = "u:7";
    opened.bridge.renderPermMatrix();
    expect(doc.getElementById("permPreview")!.textContent).toBe("");
  });

  it("previews a member-layer override by user_id", async () => {
    const calls: FetchCall[] = [];
    const opened = await openModal(calls, () => ({ channel_id: 42, evaluated: 1, members: [] }));
    dom = opened.dom;
    const doc = dom.window.document;
    (doc.getElementById("permTarget") as HTMLSelectElement).value = "u:7";
    opened.bridge.renderPermMatrix();
    (doc.querySelector('input[name="ovr1"][value="allow"]') as HTMLInputElement).checked = true;

    await opened.bridge.previewPermChange();

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/channels/42/access/preview",
        body: { allow: 1, deny: 0, user_id: 7 },
      },
    ]);
    expect(doc.getElementById("permPreview")!.textContent).toContain(
      "No member's access would change (1 evaluated)",
    );
  });
});
