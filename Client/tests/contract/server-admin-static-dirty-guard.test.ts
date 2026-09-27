// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// ARCH-10 stage 3 (UX-10): unsaved edits must not be discarded silently.
// Two guards: an operator-initiated dismissal of a dialog that holds edits
// asks first (Escape, the scrim, the close button and Cancel all reach
// dismissModal), and unloading or reloading the page warns while any unsaved
// edit exists (beforeunload).
//
// The navigation guard is deliberately NOT here: it changes navigateTo, which
// ARCH-10 stage 4 (#section history) owns, so the two do not collide.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const ADMIN_HTML_SOURCE = adminPanelHtml();

// Classic-script bindings never land on `window`; bridge the ones driven here.
const BRIDGE = `<script>
window.__test = {
  get state(){return state},
  openModal: openModal,
  dismissModal: dismissModal,
  markModalDirty: markModalDirty,
  renderChannelPermsModal: renderChannelPermsModal,
  saveChannelPerms: saveChannelPerms
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

interface Bridge {
  state: any;
  openModal: (html: string) => void;
  dismissModal: () => void;
  markModalDirty: () => void;
  renderChannelPermsModal: () => void;
  saveChannelPerms: () => Promise<void>;
}

async function boot(
  calls: FetchCall[] = [],
  respond: (p: string) => unknown = () => ({}),
): Promise<{ dom: JSDOM; bridge: Bridge; doc: Document; modalVisible: () => boolean }> {
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
  expect(bridge).toBeTruthy();
  const doc = dom.window.document;
  return {
    dom,
    bridge,
    doc,
    modalVisible: () => doc.getElementById("modal")!.classList.contains("visible"),
  };
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

function unload(dom: JSDOM): Event {
  const event = new dom.window.Event("beforeunload", { cancelable: true });
  dom.window.dispatchEvent(event);
  return event;
}

describe("Server/admin/static — dialog dirty guard (UX-10)", () => {
  let dom: JSDOM | undefined;
  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("closes a clean dialog without asking", async () => {
    const booted = await boot();
    dom = booted.dom;
    const asked = stubConfirm(dom, false);
    booted.bridge.openModal("<div class='modal-header'><h3>Clean</h3></div>");
    expect(booted.modalVisible()).toBe(true);

    booted.bridge.dismissModal();

    expect(booted.modalVisible()).toBe(false);
    expect(asked).toEqual([]);
  });

  it("refuses to close a dirty dialog when the discard is declined", async () => {
    const booted = await boot();
    dom = booted.dom;
    const asked = stubConfirm(dom, false);
    booted.bridge.openModal("<div class='modal-header'><h3>Dirty</h3></div>");
    booted.bridge.markModalDirty();

    booted.bridge.dismissModal();

    expect(booted.modalVisible()).toBe(true);
    expect(asked.length).toBe(1);
  });

  const DISMISS_ROUTES: [string, (dom: JSDOM) => void][] = [
    [
      "Escape",
      (d) =>
        d.window.document.dispatchEvent(
          new d.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    ],
    ["a click on the scrim", (d) => d.window.document.getElementById("modal")!.click()],
    [
      "the Cancel button",
      (d) =>
        (
          d.window.document.querySelector('#modalInner [data-action="closeModal"]') as HTMLElement
        ).click(),
    ],
  ];

  it.each(DISMISS_ROUTES)(
    "asks on %s and keeps a dirty dialog open when declined",
    async (_, route) => {
      const booted = await boot();
      dom = booted.dom;
      const asked = stubConfirm(dom, false);
      booted.bridge.openModal(
        '<div class="modal-body"><button data-action="closeModal">Cancel</button></div>',
      );
      booted.bridge.markModalDirty();

      route(dom);

      expect(asked.length).toBe(1);
      expect(booted.modalVisible()).toBe(true);
    },
  );

  it("asks before a close-and-refresh button discards, and refreshes only once confirmed", async () => {
    const booted = await boot();
    dom = booted.dom;
    const { bridge, doc } = booted;
    const content = doc.getElementById("content")!;
    content.innerHTML = "<p id='before'></p>";
    bridge.openModal(
      '<div class="modal-body"><button data-action="closeModalAndRefresh">Done</button></div>',
    );
    bridge.markModalDirty();
    const button = () =>
      doc.querySelector('#modalInner [data-action="closeModalAndRefresh"]') as HTMLElement;

    const declined = stubConfirm(dom, false);
    button().click();
    expect(declined.length).toBe(1);
    expect(booted.modalVisible()).toBe(true);
    expect(doc.getElementById("before")).not.toBeNull();

    const confirmed = stubConfirm(dom, true);
    button().click();
    expect(confirmed.length).toBe(1);
    expect(booted.modalVisible()).toBe(false);
    expect(doc.getElementById("before")).toBeNull();
  });

  it("ignores the change event an edited field fires after Escape closed its dialog", async () => {
    const booted = await boot();
    dom = booted.dom;
    const { bridge, doc } = booted;
    stubConfirm(dom, true);
    bridge.openModal('<div class="modal-body"><input id="banReason" value=""></div>');
    const input = doc.getElementById("banReason") as HTMLInputElement;
    input.value = "spam";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(bridge.state.modalDirty).toBe(true);

    doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(booted.modalVisible()).toBe(false);
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

    expect(bridge.state.modalDirty).toBe(false);
    expect(unload(dom).defaultPrevented).toBe(false);
  });

  it("closes a dirty dialog once the discard is confirmed, and forgets the dirt", async () => {
    const booted = await boot();
    dom = booted.dom;
    const asked = stubConfirm(dom, true);
    booted.bridge.openModal("<div class='modal-header'><h3>Dirty</h3></div>");
    booted.bridge.markModalDirty();

    booted.bridge.dismissModal();
    expect(booted.modalVisible()).toBe(false);
    expect(asked.length).toBe(1);
    expect(booted.bridge.state.modalDirty).toBe(false);
    expect(unload(dom).defaultPrevented).toBe(false);

    // A later, clean dialog must close without a prompt: the flag is per-dialog.
    const asked2 = stubConfirm(dom, false);
    booted.bridge.openModal("<div class='modal-header'><h3>Next</h3></div>");
    booted.bridge.dismissModal();
    expect(booted.modalVisible()).toBe(false);
    expect(asked2).toEqual([]);
  });

  it("marks the dialog dirty when a channel-access control is edited", async () => {
    const booted = await boot();
    dom = booted.dom;
    const { bridge, doc } = booted;
    bridge.state.permChannel = {
      id: 42,
      name: "general",
      roles: [{ role_id: 4, role_name: "Member", permissions: 0x663, allow: 0, deny: 0 }],
      users: [],
      allUsers: [{ id: 7, username: "alice" }],
      tab: "access",
    };
    bridge.renderChannelPermsModal();
    expect(bridge.state.modalDirty).toBeFalsy();

    const box = doc.getElementById("permRole4") as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new dom!.window.Event("change", { bubbles: true }));

    expect(bridge.state.modalDirty).toBe(true);
  });

  it("marks the dialog dirty when a toggle inside it is flipped", async () => {
    const booted = await boot();
    dom = booted.dom;
    const { bridge, doc } = booted;
    // Channel edit has Archived/NSFW role=switch buttons in its footer.
    bridge.openModal(
      '<div class="modal-body"><button class="toggle" role="switch" aria-checked="false" data-action="toggleSwitch"></button></div>',
    );
    const toggle = doc.querySelector('#modalInner [role="switch"]') as HTMLButtonElement;
    toggle.click();
    expect(bridge.state.modalDirty).toBe(true);
  });

  it("marks the dialog dirty when a one-click placement sets the role position", async () => {
    const booted = await boot();
    dom = booted.dom;
    const { bridge, doc } = booted;
    const asked = stubConfirm(dom, false);
    bridge.openModal(
      '<div class="modal-body"><input id="rolePos" value="9"><button type="button" data-action="placeRoleAboveDefault" data-args="[3]">Place</button></div>',
    );

    (doc.querySelector('#modalInner [data-action="placeRoleAboveDefault"]') as HTMLElement).click();
    expect((doc.getElementById("rolePos") as HTMLInputElement).value).toBe("3");
    doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(asked.length).toBe(1);
    expect(booted.modalVisible()).toBe(true);
  });

  it("does not treat a typed-name confirmation field as unsaved work", async () => {
    const booted = await boot();
    dom = booted.dom;
    const { bridge, doc } = booted;
    const asked = stubConfirm(dom, false);
    bridge.openModal(
      '<div class="modal-body"><input id="typedConfirm" value="" data-input-action="syncTypedConfirm"></div>',
    );
    const input = doc.getElementById("typedConfirm") as HTMLInputElement;
    input.value = "general";
    input.dispatchEvent(new dom!.window.Event("input", { bubbles: true }));

    // Cancel must close without asking: the confirmation field is transient.
    booted.bridge.dismissModal();
    expect(booted.modalVisible()).toBe(false);
    expect(asked).toEqual([]);
  });

  it("clears the dirt when the drawer is saved, so the post-save close does not ask", async () => {
    const calls: FetchCall[] = [];
    const booted = await boot(calls);
    dom = booted.dom;
    const { bridge, doc } = booted;
    const asked = stubConfirm(dom, false);
    bridge.state.permChannel = {
      id: 42,
      name: "general",
      roles: [{ role_id: 4, role_name: "Member", permissions: 0x663, allow: 0, deny: 0 }],
      users: [],
      allUsers: [],
      tab: "access",
    };
    bridge.renderChannelPermsModal();
    const box = doc.getElementById("permRole4") as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new dom!.window.Event("change", { bubbles: true }));

    await bridge.saveChannelPerms();

    expect(asked).toEqual([]);
    expect(booted.modalVisible()).toBe(false);
    expect(bridge.state.modalDirty).toBe(false);
    expect(unload(dom!).defaultPrevented).toBe(false);
  });
});

describe("Server/admin/static — beforeunload guard (UX-10)", () => {
  let dom: JSDOM | undefined;
  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("does not warn when nothing is unsaved", async () => {
    const booted = await boot();
    dom = booted.dom;
    booted.bridge.state.settingsChanged = false;
    expect(unload(dom).defaultPrevented).toBe(false);
  });

  it("warns while Settings has unsaved changes", async () => {
    const booted = await boot();
    dom = booted.dom;
    booted.bridge.state.settingsChanged = true;
    expect(unload(dom).defaultPrevented).toBe(true);
  });

  it("warns while a dialog holds unsaved edits", async () => {
    const booted = await boot();
    dom = booted.dom;
    booted.bridge.openModal("<div class='modal-header'><h3>Dirty</h3></div>");
    booted.bridge.markModalDirty();
    expect(unload(dom).defaultPrevented).toBe(true);
  });
});
