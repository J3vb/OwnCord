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
// open leaves the page as it is and puts the current section back in the URL.
// Leaving a page by any route — a nav click or back/forward — closes an open
// dialog through its discard guard and asks before dropping Settings edits.
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
  openModal: openModal,
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
  openModal: (html: string) => void;
  nav: { id?: string }[];
}

const ADMINISTRATOR = 0x40000000;
const OWNER_ME = {
  id: 1,
  username: "ada",
  role_name: "Owner",
  permissions: ADMINISTRATOR,
  role_position: 100,
  is_owner: true,
  server_name: "Lab",
  version: "1.2.0",
};
// A moderation-only principal: dashboard yes, tokens (owner-only) no.
const MODERATOR_ME = {
  id: 2,
  username: "mo",
  role_name: "Moderator",
  permissions: 0x8000000,
  role_position: 60,
};

function boot(me: object = OWNER_ME): {
  dom: JSDOM;
  bridge: Bridge;
  doc: Document;
  tick: () => Promise<void>;
} {
  const dom = new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (async (input: string) => {
        const p = String(input).replace(/^\/admin\/api/, "");
        let json: unknown = {};
        if (p === "/setup/status") json = { needs_setup: false };
        else if (p === "/me") json = me;
        // The list routes the page renders read return arrays, not {}.
        else if (p.startsWith("/registrations") || p.startsWith("/users")) json = [];
        else if (p.startsWith("/roles")) json = [];
        return { ok: true, status: 200, json: async () => json } as Response;
      }) as typeof fetch;
    },
  });
  const bridge = (dom.window as unknown as { __test: Bridge }).__test;
  expect(bridge).toBeTruthy();
  bridge.state.me = me;
  const tick = () => new Promise<void>((resolve) => dom.window.setTimeout(resolve, 0));
  return { dom, bridge, doc: dom.window.document, tick };
}

/** Replaces window.confirm and records the messages it was asked. */
function stubConfirm(dom: JSDOM, answer: boolean): string[] {
  const asked: string[] = [];
  dom.window.confirm = (message?: string) => {
    asked.push(String(message ?? ""));
    return answer;
  };
  return asked;
}

/** Opens Settings, waits for its form, and types into the server name. */
async function editSettings(booted: ReturnType<typeof boot>): Promise<HTMLInputElement> {
  booted.bridge.navigateTo("settings");
  let input: HTMLInputElement | null = null;
  for (let i = 0; i < 20 && !input; i++) {
    await booted.tick();
    input = booted.doc.querySelector<HTMLInputElement>("#s-server_name");
  }
  if (!input) throw new Error("the Settings form never rendered");
  input.value = "Renamed";
  input.dispatchEvent(new booted.dom.window.Event("input", { bubbles: true }));
  expect(booted.bridge.state.settingsChanged).toBe(true);
  return input;
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
    const entries = booted.dom.window.history.length;

    booted.bridge.navigateTo("audit");

    expect(booted.bridge.state.section).toBe("audit");
    expect(booted.dom.window.location.hash).toBe("#audit");
    expect(booted.dom.window.history.length).toBe(entries + 1);
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
    expect(booted.dom.window.location.hash).toBe("#dashboard");
  });

  it("ignores a hashchange naming a section the principal may not open", async () => {
    const booted = boot(MODERATOR_ME);
    dom = booted.dom;
    booted.bridge.navigateTo("dashboard");

    booted.dom.window.location.hash = "#tokens";
    await booted.tick();

    expect(booted.bridge.state.section).toBe("dashboard");
    expect(booted.dom.window.location.hash).toBe("#dashboard");
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

  it("replaces a deep link the principal may not open with the section it opened", async () => {
    const booted = boot(MODERATOR_ME);
    dom = booted.dom;
    booted.dom.window.location.hash = "#tokens";
    const entries = booted.dom.window.history.length;
    await booted.bridge.enterApp();

    expect(booted.bridge.state.section).toBe("dashboard");
    expect(booted.dom.window.location.hash).toBe("#dashboard");
    expect(booted.dom.window.history.length).toBe(entries);
  });

  it("asks before the back button discards edited Settings, and stays when declined", async () => {
    const booted = boot();
    dom = booted.dom;
    booted.bridge.navigateTo("dashboard");
    const input = await editSettings(booted);
    const asked = stubConfirm(booted.dom, false);

    booted.dom.window.location.hash = "#dashboard";
    await booted.tick();

    expect(asked).toEqual(["Discard your unsaved changes?"]);
    expect(booted.bridge.state.section).toBe("settings");
    expect(booted.bridge.state.settingsChanged).toBe(true);
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe("Renamed");
    expect(booted.dom.window.location.hash).toBe("#settings");
  });

  it("keeps the page being left in history when a back-button discard is declined", async () => {
    const booted = boot();
    dom = booted.dom;
    booted.bridge.navigateTo("dashboard");
    await editSettings(booted);
    const settle = async () => {
      for (let i = 0; i < 5; i++) await booted.tick();
    };

    stubConfirm(booted.dom, false);
    booted.dom.window.history.back();
    await settle();
    expect(booted.bridge.state.section).toBe("settings");
    expect(booted.dom.window.location.hash).toBe("#settings");

    const asked = stubConfirm(booted.dom, true);
    booted.dom.window.history.back();
    await settle();
    expect(asked).toEqual(["Discard your unsaved changes?"]);
    expect(booted.bridge.state.section).toBe("dashboard");
    expect(booted.dom.window.location.hash).toBe("#dashboard");
  });

  it("leaves edited Settings on the back button once the discard is confirmed", async () => {
    const booted = boot();
    dom = booted.dom;
    booted.bridge.navigateTo("dashboard");
    await editSettings(booted);
    const asked = stubConfirm(booted.dom, true);

    booted.dom.window.location.hash = "#dashboard";
    await booted.tick();

    expect(asked.length).toBe(1);
    expect(booted.bridge.state.section).toBe("dashboard");
    expect(booted.bridge.state.settingsChanged).toBe(false);
    expect(booted.dom.window.location.hash).toBe("#dashboard");
  });

  it("asks before a nav click discards edited Settings", async () => {
    const booted = boot();
    dom = booted.dom;
    await editSettings(booted);
    const asked = stubConfirm(booted.dom, false);
    const dashboard = Array.from(booted.doc.querySelectorAll<HTMLElement>(".nav-item")).find((b) =>
      b.textContent?.includes("Dashboard"),
    );
    expect(dashboard).toBeTruthy();

    dashboard!.click();

    expect(asked).toEqual(["Discard your unsaved changes?"]);
    expect(booted.bridge.state.section).toBe("settings");
    expect(booted.dom.window.location.hash).toBe("#settings");
  });

  it("asks before the back button discards an edited dialog, and closes it once confirmed", async () => {
    const booted = boot();
    dom = booted.dom;
    booted.bridge.navigateTo("dashboard");
    booted.bridge.navigateTo("audit");
    booted.bridge.openModal('<input class="form-input" id="dialogField">');
    const modal = booted.doc.getElementById("modal")!;
    const field = booted.doc.getElementById("dialogField") as HTMLInputElement;
    field.value = "draft";
    field.dispatchEvent(new booted.dom.window.Event("input", { bubbles: true }));

    const declined = stubConfirm(booted.dom, false);
    booted.dom.window.location.hash = "#dashboard";
    await booted.tick();

    expect(declined).toEqual(["Discard your unsaved changes?"]);
    expect(booted.bridge.state.section).toBe("audit");
    expect(modal.classList.contains("visible")).toBe(true);
    expect(booted.dom.window.location.hash).toBe("#audit");

    const confirmed = stubConfirm(booted.dom, true);
    booted.dom.window.location.hash = "#dashboard";
    await booted.tick();

    expect(confirmed.length).toBe(1);
    expect(booted.bridge.state.section).toBe("dashboard");
    expect(modal.classList.contains("visible")).toBe(false);
  });

  it("closes an unedited dialog without asking when the back button leaves its page", async () => {
    const booted = boot();
    dom = booted.dom;
    booted.bridge.navigateTo("dashboard");
    booted.bridge.navigateTo("audit");
    booted.bridge.openModal("<p>Details</p>");
    const asked = stubConfirm(booted.dom, false);

    booted.dom.window.location.hash = "#dashboard";
    await booted.tick();

    expect(asked).toEqual([]);
    expect(booted.bridge.state.section).toBe("dashboard");
    expect(booted.doc.getElementById("modal")!.classList.contains("visible")).toBe(false);
  });
});
