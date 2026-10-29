/**
 * Tests for src/app/certPrompts.ts (WP 7.4e): the trust-on-first-use and
 * fingerprint-mismatch prompts moved out of main.ts. installCertPrompts() gets
 * a small fake ws client that records its listeners, a fake router and stand-in
 * modals that record what the prompts hand them, so each prompt is driven by
 * calling the captured listener and the captured modal callbacks.
 *
 * The two edge cases the move must keep: one modal guard shared by both
 * prompts (released when the modal cannot open), and a mismatch that tears the
 * session down only for the live session's host (failing closed when the
 * modal cannot open).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WsClient, CertTofuEvent } from "@lib/ws";

interface ModalOptions {
  host: string;
  fingerprint?: string;
  storedFingerprint?: string;
  newFingerprint?: string;
  onAccept: () => void;
  onReject: () => void;
}

const hoisted = vi.hoisted(() => ({
  target: null as { host: string; token: string } | null,
  modals: [] as Array<{
    kind: "first-use" | "mismatch";
    opts: ModalOptions;
    destroy: ReturnType<typeof vi.fn>;
    mount: ReturnType<typeof vi.fn>;
  }>,
  failOpen: false,
  clearAuth: vi.fn(),
  abandonInFlight: vi.fn(),
  authenticated: true,
  setTransientError: vi.fn(),
  reconnectAfterCertAccept: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
const { modals } = hoisted;

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: hoisted.logInfo,
    warn: hoisted.logWarn,
    error: hoisted.logError,
  }),
}));
vi.mock("@stores/auth.store", () => ({
  authStore: { getState: () => ({ isAuthenticated: hoisted.authenticated }) },
  clearAuth: hoisted.clearAuth,
}));
vi.mock("@stores/ui.store", () => ({ setTransientError: hoisted.setTransientError }));
vi.mock("@lib/cert-reconnect", () => ({
  reconnectAfterCertAccept: hoisted.reconnectAfterCertAccept,
}));
vi.mock("../../src/app/session", () => ({
  sessionTarget: () => hoisted.target,
  abandonInFlight: hoisted.abandonInFlight,
}));
vi.mock("@components/CertMismatchModal", () => {
  const make = (kind: "first-use" | "mismatch") => (opts: ModalOptions) => {
    if (hoisted.failOpen) throw new Error("modal failed to open");
    const entry = { kind, opts, destroy: vi.fn(), mount: vi.fn() };
    hoisted.modals.push(entry);
    return { destroy: entry.destroy, mount: entry.mount };
  };
  return {
    createCertFirstUseModal: make("first-use"),
    createCertMismatchModal: make("mismatch"),
  };
});

import { CERT_NOT_ACCEPTED } from "@lib/ws";
import { connectText } from "../../src/i18n/connect";
import type { PageId } from "../../src/app/context";

type InstallCertPrompts = typeof import("../../src/app/certPrompts").installCertPrompts;
type CertListener = (evt: CertTofuEvent) => void;

let installCertPrompts: InstallCertPrompts;
let firstUse: CertListener;
let mismatch: CertListener;
const ws = {
  onCertFirstUse: vi.fn((l: CertListener) => {
    firstUse = l;
    return () => {};
  }),
  onCertMismatch: vi.fn((l: CertListener) => {
    mismatch = l;
    return () => {};
  }),
  startCertListener: vi.fn(() => Promise.resolve()),
  acceptCertFingerprint: vi.fn((_host: string, _fp: string) => Promise.resolve()),
  disconnect: vi.fn(),
  connect: vi.fn(),
};
const navigate = vi.fn();
const rerunHealth = vi.fn();
let page: PageId = "connect";

const EVT: CertTofuEvent = {
  host: "a.example:8443",
  fingerprint: "new-fp",
  status: "mismatch",
  storedFingerprint: "old-fp",
};

/** Lets the lazy modal import and any pending acceptance settle. */
async function settle(): Promise<void> {
  await vi.waitFor(() => undefined);
  await new Promise((r) => setTimeout(r, 0));
}

async function openFirstUse(evt: CertTofuEvent = EVT) {
  firstUse(evt);
  await settle();
  return modals[modals.length - 1]!;
}

async function openMismatch(evt: CertTofuEvent = EVT) {
  mismatch(evt);
  await settle();
  return modals[modals.length - 1]!;
}

beforeEach(async () => {
  vi.clearAllMocks();
  // A fresh module per test: the modal guard is module state.
  vi.resetModules();
  ({ installCertPrompts } = await import("../../src/app/certPrompts"));
  modals.length = 0;
  hoisted.failOpen = false;
  hoisted.target = null;
  hoisted.authenticated = true;
  page = "connect";
  ws.acceptCertFingerprint.mockImplementation(() => Promise.resolve());
  installCertPrompts(ws as unknown as WsClient, () => page, navigate, rerunHealth);
});

describe("installCertPrompts", () => {
  it("registers both listeners and starts the native cert listener once", () => {
    expect(ws.onCertFirstUse).toHaveBeenCalledTimes(1);
    expect(ws.onCertMismatch).toHaveBeenCalledTimes(1);
    expect(ws.startCertListener).toHaveBeenCalledTimes(1);
    expect(modals).toHaveLength(0);
  });

  it("logs a failed cert listener registration instead of throwing", async () => {
    ws.startCertListener.mockImplementationOnce(() => Promise.reject(new Error("no listener")));
    vi.resetModules();
    ({ installCertPrompts } = await import("../../src/app/certPrompts"));
    installCertPrompts(ws as unknown as WsClient, () => page, navigate, rerunHealth);
    await settle();
    expect(hoisted.logWarn).toHaveBeenCalledWith(
      "cert listener registration failed",
      expect.any(Error),
    );
  });
});

describe("the shared modal guard", () => {
  it("lets only one prompt open at a time across first-use and mismatch", async () => {
    const first = await openFirstUse();
    expect(first.kind).toBe("first-use");

    await openMismatch();
    await openFirstUse({ ...EVT, host: "other.example" });
    expect(modals).toHaveLength(1);

    first.opts.onReject();
    const next = await openMismatch();
    expect(next.kind).toBe("mismatch");
    expect(modals).toHaveLength(2);
  });

  it("applies in both directions: an open mismatch blocks a first-use prompt", async () => {
    const open = await openMismatch();
    await openFirstUse();
    expect(modals).toHaveLength(1);

    open.opts.onReject();
    expect((await openFirstUse()).kind).toBe("first-use");
  });

  it("is released when the modal cannot open, so a later event retries", async () => {
    hoisted.failOpen = true;
    firstUse(EVT);
    await settle();
    expect(modals).toHaveLength(0);
    expect(hoisted.logError).toHaveBeenCalledWith(
      "Failed to open certificate modal",
      expect.any(Error),
    );

    hoisted.failOpen = false;
    expect((await openFirstUse()).kind).toBe("first-use");
  });

  it("is released for a mismatch that cannot open too", async () => {
    hoisted.failOpen = true;
    mismatch(EVT);
    await settle();

    hoisted.failOpen = false;
    expect((await openMismatch()).kind).toBe("mismatch");
  });

  it("stays held while the native confirmation is pending, then releases", async () => {
    let finish: () => void = () => {};
    ws.acceptCertFingerprint.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const first = await openFirstUse();
    first.opts.onAccept();
    expect(first.destroy).toHaveBeenCalled();

    await openMismatch();
    expect(modals).toHaveLength(1);

    finish();
    await settle();
    expect((await openMismatch()).kind).toBe("mismatch");
  });
});

describe("first-use prompt", () => {
  it("shows the host and fingerprint and mounts on the document body", async () => {
    const m = await openFirstUse();
    expect(m.opts.host).toBe("a.example:8443");
    expect(m.opts.fingerprint).toBe("new-fp");
    expect(m.mount).toHaveBeenCalledWith(document.body);
  });

  it("accepting trusts the fingerprint, refreshes health and resumes a pending connect for the same host", async () => {
    hoisted.target = { host: "A.Example:8443", token: "tok" };
    const m = await openFirstUse();
    m.opts.onAccept();
    await settle();
    expect(ws.acceptCertFingerprint).toHaveBeenCalledWith("a.example:8443", "new-fp");
    expect(rerunHealth).toHaveBeenCalledTimes(1);
    expect(ws.connect).toHaveBeenCalledWith({ host: "A.Example:8443", token: "tok" });
  });

  it("does not reconnect a session that is live for a different host", async () => {
    hoisted.target = { host: "b.example:8443", token: "tok" };
    const m = await openFirstUse();
    m.opts.onAccept();
    await settle();
    expect(rerunHealth).toHaveBeenCalledTimes(1);
    expect(ws.connect).not.toHaveBeenCalled();
  });

  it("does not reconnect a target that has no token yet", async () => {
    hoisted.target = { host: "a.example:8443", token: "" };
    const m = await openFirstUse();
    m.opts.onAccept();
    await settle();
    expect(ws.connect).not.toHaveBeenCalled();
  });

  it("a declined native confirmation closes the modal and shows the notice", async () => {
    hoisted.target = { host: "a.example:8443", token: "tok" };
    ws.acceptCertFingerprint.mockImplementationOnce(() =>
      Promise.reject(new Error(CERT_NOT_ACCEPTED)),
    );
    const m = await openFirstUse();
    m.opts.onAccept();
    await settle();
    expect(m.destroy).toHaveBeenCalled();
    expect(ws.connect).not.toHaveBeenCalled();
    expect(hoisted.setTransientError).toHaveBeenCalledTimes(1);
    expect(hoisted.logInfo).toHaveBeenCalledWith("First-use certificate not accepted", {
      host: "a.example:8443",
    });
    expect((await openFirstUse()).kind).toBe("first-use");
  });

  it("another failure is logged, shows no notice, and releases the guard", async () => {
    ws.acceptCertFingerprint.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    const m = await openFirstUse();
    m.opts.onAccept();
    await settle();
    expect(hoisted.logError).toHaveBeenCalledWith(
      "Failed to trust first-use certificate",
      expect.any(Error),
    );
    expect(hoisted.setTransientError).not.toHaveBeenCalled();
    expect(rerunHealth).not.toHaveBeenCalled();
    expect((await openFirstUse()).kind).toBe("first-use");
  });

  it("rejecting never touches the live session", async () => {
    hoisted.target = { host: "a.example:8443", token: "tok" };
    const m = await openFirstUse();
    m.opts.onReject();
    expect(m.destroy).toHaveBeenCalled();
    expect(ws.disconnect).not.toHaveBeenCalled();
    expect(hoisted.clearAuth).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("mismatch prompt", () => {
  it("shows both fingerprints, falling back to the unknown label", async () => {
    const m = await openMismatch();
    expect(m.opts.storedFingerprint).toBe("old-fp");
    expect(m.opts.newFingerprint).toBe("new-fp");
    expect(m.mount).toHaveBeenCalledWith(document.body);

    m.opts.onReject();
    const bare = await openMismatch({
      host: "a.example:8443",
      fingerprint: "fp2",
      status: "mismatch",
    });
    expect(bare.opts.storedFingerprint).toBe(connectText("common.unknown"));
  });

  it("accepting reconnects through the cert-reconnect helper for the live session's host", async () => {
    hoisted.target = { host: "a.example:8443", token: "tok" };
    page = "main";
    const m = await openMismatch();
    m.opts.onAccept();
    await settle();
    expect(ws.acceptCertFingerprint).toHaveBeenCalledWith("a.example:8443", "new-fp");
    expect(hoisted.reconnectAfterCertAccept).toHaveBeenCalledTimes(1);
    const [passedWs, router, host, token] = hoisted.reconnectAfterCertAccept.mock.calls[0]!;
    expect(passedWs).toBe(ws);
    expect(host).toBe("a.example:8443");
    expect(token).toBe("tok");
    expect(router.getCurrentPage()).toBe("main");
    router.navigate("connect");
    expect(navigate).toHaveBeenCalledWith("connect");
    expect(ws.disconnect).not.toHaveBeenCalled();
  });

  it("accepting for another host does not reconnect the live session", async () => {
    hoisted.target = { host: "b.example:8443", token: "tok" };
    const m = await openMismatch();
    m.opts.onAccept();
    await settle();
    expect(hoisted.reconnectAfterCertAccept).not.toHaveBeenCalled();
  });

  it("a declined confirmation drops the session and shows the notice", async () => {
    hoisted.target = { host: "a.example:8443", token: "tok" };
    ws.acceptCertFingerprint.mockImplementationOnce(() =>
      Promise.reject(new Error(CERT_NOT_ACCEPTED)),
    );
    const m = await openMismatch();
    m.opts.onAccept();
    await settle();
    expect(ws.disconnect).toHaveBeenCalledTimes(1);
    expect(hoisted.clearAuth).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("connect");
    expect(hoisted.setTransientError).toHaveBeenCalledTimes(1);
    expect(hoisted.reconnectAfterCertAccept).not.toHaveBeenCalled();
    expect(ws.connect).not.toHaveBeenCalled();
  });

  it("another failure is logged and neither drops the session nor shows a notice", async () => {
    hoisted.target = { host: "a.example:8443", token: "tok" };
    ws.acceptCertFingerprint.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    const m = await openMismatch();
    m.opts.onAccept();
    await settle();
    expect(hoisted.logError).toHaveBeenCalledWith(
      "Failed to accept cert fingerprint",
      expect.any(Error),
    );
    expect(ws.disconnect).not.toHaveBeenCalled();
    expect(hoisted.setTransientError).not.toHaveBeenCalled();
    expect((await openMismatch()).kind).toBe("mismatch");
  });
});

describe("a mismatch drops the session only for the live session's host", () => {
  it("rejecting a mismatch for the live host disconnects, clears auth and returns to connect", async () => {
    hoisted.target = { host: "a.example:8443", token: "tok" };
    const m = await openMismatch();
    m.opts.onReject();
    expect(m.destroy).toHaveBeenCalled();
    expect(ws.disconnect).toHaveBeenCalledTimes(1);
    expect(hoisted.clearAuth).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("connect");
  });

  it("matches a bracketed IPv6 literal after normalization", async () => {
    hoisted.target = { host: "[::1]:443", token: "tok" };
    const m = await openMismatch({ ...EVT, host: "::1" });
    m.opts.onReject();
    expect(ws.disconnect).toHaveBeenCalledTimes(1);
  });

  it("matches after normalization (case, default port)", async () => {
    hoisted.target = { host: "Srv.Example:443", token: "tok" };
    const m = await openMismatch({ ...EVT, host: "srv.example" });
    m.opts.onReject();
    expect(ws.disconnect).toHaveBeenCalledTimes(1);
  });

  it("ignores a mismatch for another host", async () => {
    hoisted.target = { host: "b.example:8443", token: "tok" };
    const m = await openMismatch();
    m.opts.onReject();
    expect(ws.disconnect).not.toHaveBeenCalled();
    expect(hoisted.clearAuth).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("ignores a mismatch when no session is in flight", async () => {
    const m = await openMismatch();
    m.opts.onReject();
    expect(ws.disconnect).not.toHaveBeenCalled();
    expect(hoisted.clearAuth).not.toHaveBeenCalled();
  });

  it("fails closed when the modal cannot open for the live host", async () => {
    hoisted.target = { host: "a.example:8443", token: "tok" };
    hoisted.failOpen = true;
    mismatch(EVT);
    await settle();
    expect(modals).toHaveLength(0);
    expect(ws.disconnect).toHaveBeenCalledTimes(1);
    expect(hoisted.clearAuth).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("connect");
  });

  it("a modal that cannot open for another host leaves the session alone", async () => {
    hoisted.target = { host: "b.example:8443", token: "tok" };
    hoisted.failOpen = true;
    mismatch(EVT);
    await settle();
    expect(ws.disconnect).not.toHaveBeenCalled();
    expect(hoisted.clearAuth).not.toHaveBeenCalled();
  });

  it("a failed first-use modal never drops the session", async () => {
    hoisted.target = { host: "a.example:8443", token: "tok" };
    hoisted.failOpen = true;
    firstUse(EVT);
    await settle();
    expect(ws.disconnect).not.toHaveBeenCalled();
    expect(hoisted.clearAuth).not.toHaveBeenCalled();
  });
});

describe("a mismatch before the first auth_ok", () => {
  beforeEach(() => {
    hoisted.authenticated = false;
    hoisted.target = { host: "a.example:8443", token: "tok" };
  });

  it("rejecting tears the attempt down and ends the spinner with the notice", async () => {
    const m = await openMismatch();
    m.opts.onReject();
    expect(hoisted.clearAuth).toHaveBeenCalledTimes(1);
    expect(hoisted.abandonInFlight).toHaveBeenCalledTimes(1);
    expect(hoisted.setTransientError).toHaveBeenCalledExactlyOnceWith(
      connectText("cert.notAccepted"),
    );
    expect(navigate).toHaveBeenCalledWith("connect");
  });

  it("a later Accept for the same host does not resume the abandoned attempt", async () => {
    const first = await openMismatch();
    first.opts.onReject();
    // abandonInFlight clears the session target.
    hoisted.target = null;
    const second = await openMismatch();
    second.opts.onAccept();
    await settle();
    expect(ws.acceptCertFingerprint).toHaveBeenCalledTimes(1);
    expect(hoisted.reconnectAfterCertAccept).not.toHaveBeenCalled();
    expect(ws.connect).not.toHaveBeenCalled();
  });

  it("a declined confirmation shows the notice once", async () => {
    ws.acceptCertFingerprint.mockImplementationOnce(() =>
      Promise.reject(new Error(CERT_NOT_ACCEPTED)),
    );
    const m = await openMismatch();
    m.opts.onAccept();
    await settle();
    expect(hoisted.abandonInFlight).toHaveBeenCalledTimes(1);
    expect(hoisted.setTransientError).toHaveBeenCalledTimes(1);
  });

  it("fails closed with the notice when the modal cannot open", async () => {
    hoisted.failOpen = true;
    mismatch(EVT);
    await settle();
    expect(hoisted.abandonInFlight).toHaveBeenCalledTimes(1);
    expect(hoisted.setTransientError).toHaveBeenCalledTimes(1);
  });

  it("leaves another host's attempt alone", async () => {
    hoisted.target = { host: "b.example:8443", token: "tok" };
    const m = await openMismatch();
    m.opts.onReject();
    expect(hoisted.abandonInFlight).not.toHaveBeenCalled();
    expect(hoisted.clearAuth).not.toHaveBeenCalled();
    expect(hoisted.setTransientError).not.toHaveBeenCalled();
  });
});
