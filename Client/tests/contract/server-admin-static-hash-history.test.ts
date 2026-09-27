// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// ARCH-10 stage 4 (UX-12(a)): the URL tracks the page. Opening a section
// writes its #id to the hash, so the address bar names where you are and the
// back/forward buttons move between sections; a hashchange from the browser
// navigates to the section it names, reusing the same permission gate a click
// does. A fragment that is unknown or names a section the principal may not
// open changes nothing.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const ADMIN_HTML_SOURCE = adminPanelHtml();

// Classic-script bindings never land on `window`; bridge the ones driven here.
const BRIDGE = `<script>
window.__test = {
  get state(){return state},
  enterApp: enterApp,
  navigateTo: navigateTo,
  sectionFromHash: sectionFromHash,
  nav: NAV
};
</script>`;
if (!ADMIN_HTML_SOURCE.includes("</body>")) {
  throw new Error("expected Server/admin/static/index.html to contain </body>");
}
const ADMIN_HTML = ADMIN_HTML_SOURCE.replace("</body>", `${BRIDGE}\n</body>`);

interface Bridge {
  state: any;
  enterApp: () => Promise<void>;
  navigateTo: (id: string) => void;
  sectionFromHash: () => string;
  nav: { id?: string }[];
}

const ADMINISTRATOR = 0x40000000;

function boot(): { dom: JSDOM; bridge: Bridge; doc: Document; tick: () => Promise<void> } {
  const dom = new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (async (input: string) => {
        const p = String(input).replace(/^\/admin\/api/, "");
        let json: unknown = {};
        if (p === "/setup/status") json = { needs_setup: false };
        else if (p === "/me")
          json = {
            id: 1,
            username: "ada",
            role_name: "Owner",
            permissions: ADMINISTRATOR,
            role_position: 100,
            is_owner: true,
            server_name: "Lab",
            version: "1.2.0",
          };
        // The list routes the page renders read return arrays, not {}.
        else if (p.startsWith("/registrations") || p.startsWith("/users")) json = [];
        else if (p.startsWith("/roles")) json = [];
        return { ok: true, status: 200, json: async () => json } as Response;
      }) as typeof fetch;
    },
  });
  const bridge = (dom.window as unknown as { __test: Bridge }).__test;
  expect(bridge).toBeTruthy();
  bridge.state.me = {
    id: 1,
    permissions: ADMINISTRATOR,
    role_position: 100,
    is_owner: true,
  };
  const tick = () => new Promise<void>((resolve) => dom.window.setTimeout(resolve, 0));
  return { dom, bridge, doc: dom.window.document, tick };
}

describe("Server/admin/static — hash history (UX-12a)", () => {
  let dom: JSDOM | undefined;
  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("writes the section's id to the hash when a section is opened", async () => {
    const booted = boot();
    dom = booted.dom;

    booted.bridge.navigateTo("audit");

    expect(booted.bridge.state.section).toBe("audit");
    expect(booted.dom.window.location.hash).toBe("#audit");
  });

  it("navigates to the section a hashchange names (the back/forward buttons)", async () => {
    const booted = boot();
    dom = booted.dom;
    booted.bridge.navigateTo("dashboard");
    expect(booted.bridge.state.section).toBe("dashboard");

    // The browser's back/forward change the hash; jsdom dispatches hashchange
    // asynchronously, so let the task queue drain.
    booted.dom.window.location.hash = "#users";
    await booted.tick();

    expect(booted.bridge.state.section).toBe("users");
    expect(booted.doc.querySelector(".page-title")?.textContent).toBe("Members");
  });

  it("ignores a hashchange naming an unknown section", async () => {
    const booted = boot();
    dom = booted.dom;
    booted.bridge.navigateTo("dashboard");

    booted.dom.window.location.hash = "#not-a-section";
    await booted.tick();

    expect(booted.bridge.state.section).toBe("dashboard");
    expect(booted.bridge.sectionFromHash()).toBe("");
  });

  it("ignores a hashchange naming a section the principal may not open", async () => {
    const booted = boot();
    dom = booted.dom;
    // A moderation-only principal: dashboard yes, tokens (owner-only) no.
    booted.bridge.state.me = { id: 2, permissions: 0x8000000, role_position: 60 };
    booted.bridge.navigateTo("dashboard");

    booted.dom.window.location.hash = "#tokens";
    await booted.tick();

    expect(booted.bridge.state.section).toBe("dashboard");
  });

  it("does not add a history entry when re-opening the current section", async () => {
    const booted = boot();
    dom = booted.dom;
    booted.bridge.navigateTo("audit");
    const entries = booted.dom.window.history.length;

    booted.bridge.navigateTo("audit");

    expect(booted.dom.window.location.hash).toBe("#audit");
    expect(booted.dom.window.history.length).toBe(entries);
  });

  it("still lands on a deep-linked section at load", async () => {
    const booted = boot();
    dom = booted.dom;
    booted.dom.window.location.hash = "#roles";
    await booted.bridge.enterApp();

    expect(booted.bridge.state.section).toBe("roles");
    expect(booted.dom.window.location.hash).toBe("#roles");
  });
});
