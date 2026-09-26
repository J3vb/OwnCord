// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can execute
// this SPA. See docs/contributing.md#testing for the membership rule.
//
// The first-run setup wizard and the sign-in card (Server/admin/static/js/
// setup.js), driven through their forms the way a keyboard user drives them:
// labelled steps, Enter submits, a rejected field is flagged and focused, the
// TLS step says what each mode means for the desktop client, and the finish
// screen hands over the address, invite code and certificate fingerprint.
import { describe, it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { adminPanelHtml } from "../helpers/admin-panel";

const ADMIN_HTML = adminPanelHtml();

const DEFAULTS = {
  server_name: "OwnCord Server",
  motd: "Welcome!",
  registration_mode: "invite",
  port: 8443,
  tls_mode: "self_signed",
  tls_domain: "",
  upload_max_size_mb: 100,
  voice_quality: "medium",
  voice_auto_download: true,
};

interface Call {
  method: string;
  path: string;
  body: unknown;
}

type SetupReply = { status?: number; json: Record<string, unknown> };

async function boot(
  setupReply: SetupReply = { json: { token: "T", invite_code: "INV-1" } },
): Promise<{ dom: JSDOM; doc: Document; calls: Call[] }> {
  const calls: Call[] = [];
  const dom = new JSDOM(ADMIN_HTML, {
    url: "http://localhost:8080/admin",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (async (input: string, opts: Record<string, unknown> = {}) => {
        const method = String((opts.method as string) || "GET").toUpperCase();
        const p = String(input).replace(/^\/admin\/api/, "");
        calls.push({
          method,
          path: p,
          body: typeof opts.body === "string" ? JSON.parse(opts.body) : undefined,
        });
        let r: SetupReply = { json: {} };
        if (p === "/setup/status") r = { json: { needs_setup: true, defaults: DEFAULTS } };
        else if (p === "/setup") r = setupReply;
        else if (p === "/api/v1/auth/login")
          r = { status: 401, json: { message: "invalid credentials" } };
        const status = r.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => r.json,
        } as Response;
      }) as typeof fetch;
    },
  });
  await settle(dom);
  return { dom, doc: dom.window.document, calls };
}

async function settle(dom: JSDOM): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
}

function field(doc: Document, id: string): HTMLInputElement {
  const el = doc.getElementById(id) as HTMLInputElement | null;
  if (!el) throw new Error(`#${id} is not rendered`);
  return el;
}

async function submit(dom: JSDOM, id = "wizardForm"): Promise<void> {
  (dom.window.document.getElementById(id) as HTMLFormElement).requestSubmit();
  await settle(dom);
}

function progress(doc: Document): string {
  return doc.querySelector("#wizardBox .wiz-progress")?.textContent ?? "";
}

async function fillAccount(dom: JSDOM): Promise<void> {
  const doc = dom.window.document;
  field(doc, "wizToken").value = "SETUP-TOKEN";
  field(doc, "wizUser").value = "owner";
  field(doc, "wizPass").value = "owner-pass-123";
  field(doc, "wizConfirm").value = "owner-pass-123";
}

describe("Server/admin/static — setup wizard and sign-in", () => {
  let dom: JSDOM | undefined;
  afterEach(() => {
    dom?.window?.close();
    dom = undefined;
  });

  it("labels every step and every control, and submits with Enter", async () => {
    const booted = await boot();
    dom = booted.dom;
    const { doc } = booted;
    expect(doc.getElementById("setupOverlay")!.classList.contains("visible")).toBe(true);

    const seen: string[] = [];
    for (let step = 0; step < 6; step++) {
      seen.push(progress(doc));
      // One title per step, and it names the form.
      const titles = doc.querySelectorAll("#wizardBox h1");
      expect(titles.length, `step ${step}`).toBe(1);
      expect(doc.getElementById("wizardForm")!.getAttribute("aria-labelledby")).toBe(titles[0]?.id);
      for (const el of doc.querySelectorAll<HTMLElement>("#wizardBox input, #wizardBox select")) {
        const labelled =
          !!doc.querySelector(`label[for="${el.id}"]`) || el.hasAttribute("aria-labelledby");
        expect(labelled, `step ${step} #${el.id}`).toBe(true);
      }
      // Only the Next/Finish button submits: Back, Skip and the voice
      // switch must not advance the form when clicked.
      for (const b of doc.querySelectorAll<HTMLButtonElement>("#wizardBox button")) {
        if (b.id !== "wizNextBtn") expect(b.type, `step ${step} ${b.textContent}`).toBe("button");
      }
      if (step === 1) await fillAccount(dom);
      if (step < 5) await submit(dom);
    }
    expect(seen).toEqual([
      "Step 1 of 6 · Welcome",
      "Step 2 of 6 · Account",
      "Step 3 of 6 · Server",
      "Step 4 of 6 · Uploads & voice",
      "Step 5 of 6 · Access",
      "Step 6 of 6 · Review",
    ]);
    // The review shows words, not the raw enum values.
    const review = doc.querySelector("#wizardBox .wiz-review")!.textContent;
    expect(review).toContain("Medium");
    expect(review).toContain("Self-signed certificate");
    expect(review).not.toMatch(/\bmedium\b|self_signed/);
  });

  it("flags and focuses the field a step rejects, in an alert region", async () => {
    const booted = await boot();
    dom = booted.dom;
    const { doc } = booted;
    await submit(dom);
    await fillAccount(dom);
    field(doc, "wizConfirm").value = "something-else";
    await submit(dom);

    const err = doc.getElementById("wizErr")!;
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).toBe("Passwords do not match.");
    const confirm = field(doc, "wizConfirm");
    expect(confirm.getAttribute("aria-invalid")).toBe("true");
    expect(confirm.getAttribute("aria-describedby")).toContain("wizErr");
    expect(doc.activeElement).toBe(confirm);
    expect(progress(doc)).toBe("Step 2 of 6 · Account");

    // Fixing it moves the flag to the next bad field rather than leaving both.
    confirm.value = "owner-pass-123";
    field(doc, "wizToken").value = "";
    await submit(dom);
    expect(confirm.hasAttribute("aria-invalid")).toBe(false);
    expect(field(doc, "wizToken").getAttribute("aria-invalid")).toBe("true");
  });

  // OP-06: the TLS step has to say what each mode does to the desktop client,
  // which pins the certificate it is shown and connects only over wss://.
  it("explains each TLS mode in terms of the desktop client and the real ports", async () => {
    const booted = await boot();
    dom = booted.dom;
    const { doc } = booted;
    await submit(dom);
    await fillAccount(dom);
    await submit(dom);
    expect(progress(doc)).toBe("Step 3 of 6 · Server");

    const tls = doc.getElementById("wizTLS") as HTMLSelectElement;
    const hint = () => doc.getElementById("wizTLSHint")!.textContent ?? "";
    const pick = (mode: string) => {
      tls.value = mode;
      tls.dispatchEvent(new dom!.window.Event("change", { bubbles: true }));
    };
    expect(tls.getAttribute("aria-describedby")).toBe("wizTLSHint");
    expect(doc.querySelector('label[for="wizTLS"]')).toBeTruthy();

    pick("self_signed");
    expect(hint()).toMatch(/publish its fingerprint/);

    field(doc, "wizPort").value = "9443";
    field(doc, "wizPort").dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    pick("acme");
    expect(hint()).toMatch(/port 80 and port 9443/);
    expect(hint()).toMatch(/renewal/);
    expect(hint()).toMatch(/certificate-changed warning/);
    expect((doc.getElementById("wizDomainGroup") as HTMLElement).hidden).toBe(false);

    pick("off");
    expect(hint()).toMatch(/wss:\/\//);
    expect(hint()).toMatch(/cannot connect/);
    expect((doc.getElementById("wizDomainGroup") as HTMLElement).hidden).toBe(true);
    expect(tls.selectedOptions[0]?.textContent).not.toMatch(/testing/i);
  });

  it("finishes with the one-time setup token and shows address, invite and fingerprint", async () => {
    const booted = await boot({
      json: { token: "T", invite_code: "INV-1", certificate_fingerprint: "AA:BB:CC" },
    });
    dom = booted.dom;
    const { doc, calls } = booted;
    await submit(dom);
    await fillAccount(dom);
    for (let i = 0; i < 5; i++) await submit(dom);

    const setup = calls.find((c) => c.path === "/setup" && c.method === "POST");
    expect(setup?.body).toMatchObject({
      setup_token: "SETUP-TOKEN",
      username: "owner",
      password: "owner-pass-123",
      wizard: { port: 8443, tls_mode: "self_signed" },
    });
    expect(doc.getElementById("setupSuccessOverlay")!.classList.contains("visible")).toBe(true);
    expect(doc.getElementById("setupAddress")!.textContent).toBe("localhost:8080");
    // A loopback address is not what members on other machines type.
    expect(doc.getElementById("setupAddressHint")!.textContent).toMatch(/other machines/);
    expect(doc.getElementById("inviteCode")!.textContent).toBe("INV-1");
    expect(doc.getElementById("certFingerprint")!.textContent).toBe("AA:BB:CC");
    expect(doc.getElementById("setupFingerprint")!.classList.contains("hidden")).toBe(false);
    expect(doc.getElementById("setupFingerprintLater")!.classList.contains("hidden")).toBe(true);
    expect(doc.activeElement).toBe(doc.getElementById("setupTitle"));
  });

  it("points at the restarted address when the wizard moved the port", async () => {
    const booted = await boot({
      json: {
        token: "T",
        invite_code: "INV-1",
        restart_required: true,
        restart_url: "https://chat.lan:9443/admin",
      },
    });
    dom = booted.dom;
    const { doc } = booted;
    await submit(dom);
    await fillAccount(dom);
    await submit(dom);
    field(doc, "wizPort").value = "9443";
    for (let i = 0; i < 4; i++) await submit(dom);

    expect(doc.getElementById("setupAddress")!.textContent).toBe("chat.lan:9443");
    expect(doc.getElementById("setupRestart")!.classList.contains("hidden")).toBe(false);
    expect(doc.getElementById("setupContinueBtn")!.classList.contains("hidden")).toBe(true);
    // No fingerprint yet: the restart serves the certificate, so say where it
    // will be rather than leaving it out silently.
    expect(doc.getElementById("setupFingerprint")!.classList.contains("hidden")).toBe(true);
    expect(doc.getElementById("setupFingerprintLater")!.classList.contains("hidden")).toBe(false);
  });

  it("keeps the quick path to an account-only payload with the setup token", async () => {
    const booted = await boot();
    dom = booted.dom;
    const { doc, calls } = booted;
    (doc.querySelector('#wizardBox [data-action="wizSkip"]') as HTMLButtonElement).click();
    expect(progress(doc)).toBe("Quick setup · Account");
    await fillAccount(dom);
    await submit(dom);

    const setup = calls.find((c) => c.path === "/setup" && c.method === "POST");
    expect(setup?.body).toEqual({
      setup_token: "SETUP-TOKEN",
      username: "owner",
      password: "owner-pass-123",
    });
    expect(doc.getElementById("setupSuccessOverlay")!.classList.contains("visible")).toBe(true);
  });

  it("shows a server rejection in the alert region and re-enables Finish", async () => {
    const booted = await boot({ status: 403, json: { message: "invalid setup token" } });
    dom = booted.dom;
    const { doc } = booted;
    (doc.querySelector('#wizardBox [data-action="wizSkip"]') as HTMLButtonElement).click();
    await fillAccount(dom);
    await submit(dom);

    expect(doc.getElementById("wizErr")!.textContent).toBe("invalid setup token");
    const btn = doc.getElementById("wizNextBtn") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Create Owner Account");
    expect(doc.getElementById("setupSuccessOverlay")!.classList.contains("visible")).toBe(false);
  });

  it("signs in through a labelled form and words a wrong password as a sentence", async () => {
    const booted = await boot();
    dom = booted.dom;
    const { doc } = booted;
    for (const id of ["loginUser", "loginPass"]) {
      const input = field(doc, id);
      expect(doc.querySelector(`label[for="${id}"]`), id).toBeTruthy();
      expect(input.form?.id).toBe("loginStep1");
    }
    expect((doc.getElementById("loginBtn") as HTMLButtonElement).type).toBe("submit");
    expect(doc.getElementById("loginErr")!.getAttribute("role")).toBe("alert");

    field(doc, "loginUser").value = "owner";
    field(doc, "loginPass").value = "wrong";
    await submit(dom, "loginStep1");
    expect(doc.getElementById("loginErr")!.textContent).toBe("Wrong username or password.");
  });
});
